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
        const val ACTION_EXIT = "vn.zalo.autoreply.EXIT"
        const val ACTION_SHOW_OVERLAY = "vn.zalo.autoreply.SHOW_OVERLAY"
        const val ACTION_HIDE_OVERLAY = "vn.zalo.autoreply.HIDE_OVERLAY"
        const val ACTION_ORDER = "vn.zalo.autoreply.ORDER"
        const val EXTRA_ORDER = "order"
        private const val FOREGROUND_CHANNEL = "bot_service"
        private const val FOREGROUND_ID = 4101
    }

    private val worker = Executors.newSingleThreadExecutor()
    private lateinit var preferences: android.content.SharedPreferences
    private lateinit var secretStore: SecretStore
    private lateinit var connectivity: ConnectivityManager
    private var socket: Socket? = null
    private var overlay: OverlayController? = null
    private var textToSpeech: TextToSpeech? = null
    private var ttsReady = false
    private var lastBotStatus: JSONObject? = null

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            socket?.connect()
        }

        override fun onLost(network: Network) {
            updateForeground("Mất mạng, đang chờ kết nối lại")
            overlay?.updateStatus("Mất kết nối máy chủ", false)
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
            ACTION_START -> sendControl("start")
            ACTION_STOP -> sendControl("stop")
            ACTION_EXIT -> stopSelf()
            ACTION_SHOW_OVERLAY -> showOverlay()
            ACTION_HIDE_OVERLAY -> hideOverlay()
            ACTION_ORDER -> intent.getStringExtra(EXTRA_ORDER)?.let {
                handleOrder(
                    JSONObject(it),
                    intent.getBooleanExtra("sound", true),
                    intent.getBooleanExtra("vibrate", true),
                    intent.getBooleanExtra("speech", false)
                )
            }
            else -> reconnectSocket()
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        hideOverlay()
        socket?.off()
        socket?.disconnect()
        socket = null
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
            return
        }

        socket?.off()
        socket?.disconnect()
        val options = IO.Options().apply {
            auth = mapOf("token" to token)
            reconnection = true
            reconnectionDelay = 1000L
            reconnectionDelayMax = 30000L
            timeout = 10000L
            transports = arrayOf("websocket")
        }
        socket = IO.socket(URI.create(serverUrl), options).apply {
            on(Socket.EVENT_CONNECT) {
                updateForeground("Bot nhận đơn đang hoạt động")
                overlay?.updateStatus("Đã kết nối máy chủ", true)
            }
            on(Socket.EVENT_DISCONNECT) {
                updateForeground("Đang kết nối lại máy chủ")
                overlay?.updateStatus("Mất kết nối máy chủ", false)
            }
            on(Socket.EVENT_CONNECT_ERROR) {
                updateForeground("Không thể kết nối máy chủ")
                overlay?.updateStatus("Mất kết nối máy chủ", false)
            }
            on("status") { args ->
                val status = args.firstOrNull() as? JSONObject
                if (status != null) {
                    lastBotStatus = status
                    renderBotStatus(status)
                }
            }
            on("redis") { args ->
                val redis = args.firstOrNull() as? JSONObject
                val status = lastBotStatus
                if (redis != null && status != null) {
                    status.put("redis", redis)
                    renderBotStatus(status)
                }
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

    private fun renderBotStatus(status: JSONObject) {
        val enabled = status.optBoolean("enabled")
        val mode = status.optString("mode", "all")
        val routeStats = status.optJSONObject("priorityRouteStats")
        val redis = status.optJSONObject("redis")
        val redisConnected = redis?.optBoolean("connected") == true
        val subscriberConnected = redis?.optBoolean("subscriberConnected", true) != false
        preferences.edit().putString("mode", mode).apply()
        overlay?.updateBotState(status)
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

    private fun showOverlay() {
        if (!android.provider.Settings.canDrawOverlays(this)) return
        if (overlay == null) {
            overlay = OverlayController(this, ::sendControl) { stopSelf() }
        }
        overlay?.show()
        lastBotStatus?.let { overlay?.updateBotState(it) }
    }

    private fun hideOverlay() {
        overlay?.hide()
        overlay = null
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
