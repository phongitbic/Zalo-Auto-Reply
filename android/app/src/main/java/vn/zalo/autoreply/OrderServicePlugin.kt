package vn.zalo.autoreply

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.lang.ref.WeakReference

@CapacitorPlugin(name = "OrderService")
class OrderServicePlugin : Plugin() {
    companion object {
        @Volatile
        private var activePlugin: WeakReference<OrderServicePlugin>? = null

        fun publish(eventName: String, payload: JSONObject) {
            activePlugin?.get()?.publishToWebView(eventName, payload)
        }
    }

    override fun load() {
        activePlugin = WeakReference(this)
    }

    override fun handleOnDestroy() {
        if (activePlugin?.get() === this) activePlugin = null
        super.handleOnDestroy()
    }

    private fun publishToWebView(eventName: String, payload: JSONObject) {
        runCatching { notifyListeners(eventName, JSObject.fromJSONObject(payload)) }
    }

    private fun saveSettings(settings: JSObject) {
        context.getSharedPreferences(OrderForegroundService.PREFERENCES, 0).edit()
            .putBoolean("sound", settings.optBoolean("sound", true))
            .putBoolean("vibrate", settings.optBoolean("vibrate", true))
            .putBoolean("speech", settings.optBoolean("speech", false))
            .apply()
    }

    @PluginMethod
    fun getConnection(call: PluginCall) {
        val serverUrl = context.getSharedPreferences(OrderForegroundService.PREFERENCES, 0)
            .getString("server_url", "") ?: ""
        val result = JSObject()
        result.put("serverUrl", serverUrl)
        result.put("token", SecretStore(context).getToken() ?: "")
        call.resolve(result)
    }

    @PluginMethod
    fun start(call: PluginCall) {
        val serverUrl = ServerUrlPolicy.normalize(call.getString("serverUrl"))
        val token = call.getString("token")
        if (serverUrl == null) {
            call.reject("Địa chỉ máy chủ phải bắt đầu bằng http:// hoặc https:// và không có đường dẫn")
            return
        }
        if (token.isNullOrBlank()) {
            call.reject("Cần token quản trị")
            return
        }

        val settings = call.getObject("settings") ?: JSObject()
        context.getSharedPreferences(OrderForegroundService.PREFERENCES, 0).edit()
            .putString("server_url", serverUrl)
            .apply()
        saveSettings(settings)
        SecretStore(context).putToken(token)

        ContextCompat.startForegroundService(
            context,
            Intent(context, OrderForegroundService::class.java).setAction(OrderForegroundService.ACTION_CONNECT)
        )
        call.resolve()
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        context.stopService(Intent(context, OrderForegroundService::class.java))
        call.resolve()
    }

    @PluginMethod
    fun updateSettings(call: PluginCall) {
        saveSettings(call.getObject("settings") ?: JSObject())
        call.resolve()
    }

    @PluginMethod
    fun openAppSettings(call: PluginCall) {
        context.startActivity(
            Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:${context.packageName}")
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
        call.resolve()
    }

}
