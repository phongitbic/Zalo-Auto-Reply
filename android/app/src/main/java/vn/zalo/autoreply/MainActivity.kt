package vn.zalo.autoreply

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import androidx.core.content.ContextCompat
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(OrderServicePlugin::class.java)
        super.onCreate(savedInstanceState)
    }

    override fun onResume() {
        super.onResume()
        val preferences = getSharedPreferences(OrderForegroundService.PREFERENCES, Context.MODE_PRIVATE)
        val shouldShowOverlay = preferences.getBoolean(OverlayController.PREFERENCE_ENABLED, true) ||
            preferences.getBoolean(OverlayController.PREFERENCE_MANUAL_REPLY_ENABLED, false)
        if (shouldShowOverlay &&
            Settings.canDrawOverlays(this)
        ) {
            ContextCompat.startForegroundService(
                this,
                Intent(this, OrderForegroundService::class.java)
                    .setAction(OrderForegroundService.ACTION_REFRESH_OVERLAY)
            )
        }
    }
}
