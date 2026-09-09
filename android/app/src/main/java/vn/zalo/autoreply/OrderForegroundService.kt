package vn.zalo.autoreply

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.IBinder
import android.speech.tts.TextToSpeech
import androidx.core.app.NotificationCompat
import io.socket.client.IO
import io.socket.client.Socket
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.util.Locale
import java.util.concurrent.Executors

class OrderForegroundService : Service(), TextToSpeech.OnInitListener {
    companion object {
        const val PREFERENCES = "order_service"
        const val ACTION_CONNECT = "vn.zalo.autoreply.CONNECT"
        const val ACTION_START = "vn.zalo.autoreply.START"
        const val ACTION_STOP = "vn.zalo.autoreply.STOP"
        private const val FOREGROUND_CHANNEL = "bot_service"
        private const val FOREGROUND_ID = 4101
    }

    private val worker = Executors.newSingleThreadExecutor()
    private lateinit var preferences: android.content.SharedPreferences
    private lateinit var secretStore: SecretStore
    private lateinit var connectivity: ConnectivityManager
    private var socket: Socket? = null
    private var textToSpeech: TextToSpeech? = null
    private var ttsReady = false
    private var lastBotStatus: JSONObject? = null
    private var activeServerUrl: String? = null
    private var activeToken: String? = null

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            socket?.connect()
        }

        override fun onLost(network: Network) {
            updateForeground("Mất mạng, đang chờ kết nối lại")
            publishConnection("disconnected")
        }
    }

    override fun onCreate() {
        super.onCreate()
        preferences = getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        secretStore = SecretStore(this)
        connectivity = getSystemService(ConnectivityManager::class.java)
        textToSpeech = TextToSpeech(this, this)
        createForegroundChannel()
        startForeground(FOREGROUND_ID, foregroundNotification("Đang kết nối máy chủ"))
        try {
            connectivity.registerDefaultNetworkCallback(networkCallback)
        } catch (_: Exception) {
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_CONNECT -> reconnectSocket()
            ACTION_START -> sendControl("start")
            ACTION_STOP -> sendControl("stop")
            else -> reconnectSocket()
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        socket?.off()
        socket?.disconnect()
        socket = null
        activeServerUrl = null
        activeToken = null
        try {
            connectivity.unregisterNetworkCallback(networkCallback)
        } catch (_: Exception) {
        }
        textToSpeech?.stop()
        textToSpeech?.shutdown()
        worker.shutdownNow()
        super.onDestroy()
    }

    override fun onInit(status: Int) {
        if (status == TextToSpeech.SUCCESS) {
            ttsReady = (textToSpeech?.setLanguage(Locale.forLanguageTag("vi-VN")) ?: TextToSpeech.LANG_NOT_SUPPORTED) >= 0
        }
    }

    private fun reconnectSocket() {
        val serverUrl = ServerUrlPolicy.normalize(preferences.getString("server_url", null))
        val token = secretStore.getToken()
        if (serverUrl.isNullOrBlank() || token.isNullOrBlank()) {
            updateForeground("Chưa cấu hình địa chỉ máy chủ")
            publishConnection("error", "Chưa cấu hình địa chỉ máy chủ")
            return
        }

        if (serverUrl == activeServerUrl && token == activeToken && socket?.connected() == true) {
            publishConnection("connected")
            lastBotStatus?.let { OrderServicePlugin.publish("serverStatus", it) }
            return
        }

        socket?.off()
        socket?.disconnect()
        activeServerUrl = serverUrl
        activeToken = token
        val options = IO.Options().apply {
            auth = mapOf("token" to token, "clientType" to "android-service")
            reconnection = true
            reconnectionDelay = 1000L
            reconnectionDelayMax = 5000L
            timeout = 10000L
            transports = arrayOf("websocket")
        }
        socket = IO.socket(URI.create(serverUrl), options).apply {
            on(Socket.EVENT_CONNECT) {
                updateForeground("Bot nhận đơn đang hoạt động")
                publishConnection("connected")
            }
            on(Socket.EVENT_DISCONNECT) {
                updateForeground("Đang kết nối lại máy chủ")
                publishConnection("disconnected")
            }
            on(Socket.EVENT_CONNECT_ERROR) { args ->
                updateForeground("Không thể kết nối máy chủ")
                publishConnection("error", args.firstOrNull()?.toString())
            }
            on("status") { args ->
                val status = args.firstOrNull() as? JSONObject
                if (status != null) {
                    lastBotStatus = status
                    renderBotStatus(status)
                    OrderServicePlugin.publish("serverStatus", status)
                }
            }
            on("stats") { args ->
                (args.firstOrNull() as? JSONObject)?.let { OrderServicePlugin.publish("serverStats", it) }
            }
            on("redis") { args ->
                val redis = args.firstOrNull() as? JSONObject
                val status = lastBotStatus
                if (redis != null) {
                    if (status != null) {
                        status.put("redis", redis)
                        renderBotStatus(status)
                    }
                    OrderServicePlugin.publish("serverRedis", redis)
                }
            }
            on("qr") { args ->
                (args.firstOrNull() as? JSONObject)?.let { OrderServicePlugin.publish("zaloQr", it) }
            }
            on("ORDER_ACCEPTED") { args ->
                val order = args.firstOrNull() as? JSONObject
                if (order != null) {
                    handleOrder(
                        order,
                        preferences.getBoolean("sound", true),
                        preferences.getBoolean("vibrate", true),
                        preferences.getBoolean("speech", false)
                    )
                }
            }
            connect()
        }
    }

    private fun publishConnection(state: String, message: String? = null) {
        val payload = JSONObject().put("state", state)
        if (!message.isNullOrBlank()) payload.put("message", message)
        OrderServicePlugin.publish("connectionState", payload)
    }

    private fun renderBotStatus(status: JSONObject) {
        val enabled = status.optBoolean("enabled")
        val mode = status.optString("mode", "all")
        val routeStats = status.optJSONObject("priorityRouteStats")
        val redis = status.optJSONObject("redis")
        val redisConnected = redis?.optBoolean("connected") == true
        val subscriberConnected = redis?.optBoolean("subscriberConnected", true) != false
        preferences.edit().putString("mode", mode).apply()
        val modeLabel = if (!enabled) "Đã dừng nhận đơn"
            else if (mode == "priority") "Đang nhận cuốc ưu tiên"
            else "Đang nhận tất cả"
        val redisLabel = if (!redisConnected) "mất kết nối"
            else if (!subscriberConnected) "đang nối lại đồng bộ"
            else "ổn định"
        updateForeground(
            "$modeLabel · ${routeStats?.optInt("enabled", 0) ?: 0} tuyến bật · Redis $redisLabel"
        )
    }

    private fun handleOrder(order: JSONObject, sound: Boolean, vibrate: Boolean, speech: Boolean) {
        if (!OrderNotifier.show(this, order, sound, vibrate)) return
        if (speech && ttsReady) {
            textToSpeech?.speak("Đã nhận đơn thành công", TextToSpeech.QUEUE_FLUSH, null, order.optString("eventId"))
        }
    }

    fun sendControl(action: String, mode: String = preferences.getString("mode", "all") ?: "all") {
        preferences.edit().putString("mode", mode).apply()
        val serverUrl = ServerUrlPolicy.normalize(preferences.getString("server_url", null)) ?: return
        val token = secretStore.getToken() ?: return
        worker.execute {
            try {
                val connection = URL("$serverUrl/api/bot/control").openConnection() as HttpURLConnection
                connection.requestMethod = "POST"
                connection.connectTimeout = 10000
                connection.readTimeout = 10000
                connection.doOutput = true
                connection.setRequestProperty("Authorization", "Bearer $token")
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { output ->
                    output.write(JSONObject(mapOf("action" to action, "mode" to mode)).toString().toByteArray())
                }
                val succeeded = connection.responseCode in 200..299
                connection.disconnect()
                updateForeground(if (succeeded) {
                    if (action == "start") "Bot nhận đơn đang hoạt động" else "Đã dừng nhận đơn"
                } else "Máy chủ từ chối thao tác")
            } catch (_: Exception) {
                updateForeground("Mất kết nối máy chủ")
            }
        }
    }

    private fun createForegroundChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            FOREGROUND_CHANNEL,
            "Dịch vụ nhận đơn",
            NotificationManager.IMPORTANCE_LOW
        ).apply { description = "Duy trì kết nối với máy chủ khi ứng dụng chạy nền" }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun foregroundNotification(text: String): android.app.Notification {
        val openApp = PendingIntent.getActivity(
            this, 1, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, FOREGROUND_CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("Bot nhận đơn đang hoạt động")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(openApp)
            .addAction(0, "Bắt đầu", serviceAction(ACTION_START, 2))
            .addAction(0, "Dừng", serviceAction(ACTION_STOP, 3))
            .addAction(0, "Mở", openApp)
            .build()
    }

    private fun serviceAction(action: String, requestCode: Int): PendingIntent = PendingIntent.getService(
        this,
        requestCode,
        Intent(this, OrderForegroundService::class.java).setAction(action),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    private fun updateForeground(text: String) {
        getSystemService(NotificationManager::class.java).notify(FOREGROUND_ID, foregroundNotification(text))
    }
}
