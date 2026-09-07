package vn.zalo.autoreply

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject
import kotlin.math.abs

@SuppressLint("SetTextI18n")
class OverlayController(
    private val context: Context,
    private val control: (String, String) -> Unit,
    private val exit: () -> Unit
) {
    private val windowManager = context.getSystemService(WindowManager::class.java)
    private val preferences = context.getSharedPreferences(OrderForegroundService.PREFERENCES, Context.MODE_PRIVATE)
    private val handler = Handler(Looper.getMainLooper())
    private var root: LinearLayout? = null
    private var panel: LinearLayout? = null
    private var status: TextView? = null
    private var mode = preferences.getString("mode", "all") ?: "all"
    @Suppress("DEPRECATION")
    private val overlayWindowType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
    } else {
        WindowManager.LayoutParams.TYPE_PHONE
    }
    private val params = WindowManager.LayoutParams(
        WindowManager.LayoutParams.WRAP_CONTENT,
        WindowManager.LayoutParams.WRAP_CONTENT,
        overlayWindowType,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
        PixelFormat.TRANSLUCENT
    ).apply {
        gravity = Gravity.TOP or Gravity.START
        x = preferences.getInt("overlay_x", 16)
        y = preferences.getInt("overlay_y", 180)
    }

    fun show() = handler.post {
        if (root != null) return@post
        root = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(6), dp(6), dp(6), dp(6))
            setBackgroundColor(Color.argb(225, 8, 22, 39))
        }
        val bubble = TextView(context).apply {
            text = "ĐƠN"
            gravity = Gravity.CENTER
            setTextColor(Color.WHITE)
            setTextSize(12f)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            setBackgroundColor(Color.rgb(20, 176, 130))
            layoutParams = LinearLayout.LayoutParams(dp(58), dp(58))
        }
        panel = buildPanel().also { it.visibility = View.GONE }
        root?.addView(bubble)
        root?.addView(panel)
        attachDrag(bubble)
        windowManager.addView(root, params)
    }

    fun hide() = handler.post {
        root?.let { runCatching { windowManager.removeView(it) } }
        root = null
        panel = null
        status = null
    }

    fun updateStatus(text: String, connected: Boolean) = handler.post {
        status?.text = text
        status?.setTextColor(if (connected) Color.rgb(55, 224, 166) else Color.rgb(255, 105, 130))
    }

    fun updateBotState(botStatus: JSONObject) = handler.post {
        val enabled = botStatus.optBoolean("enabled")
        mode = botStatus.optString("mode", "all")
        preferences.edit().putString("mode", mode).apply()
        val routes = botStatus.optJSONObject("priorityRouteStats")
        val redis = botStatus.optJSONObject("redis")
        val updatedAt = botStatus.optString("configUpdatedAt", redis?.optString("lastSyncedAt", "") ?: "")
        val headline = if (!enabled) "Đã dừng nhận đơn"
            else if (mode == "priority") "Đang nhận cuốc ưu tiên"
            else "Đang nhận tất cả"
        val routeLine = "Tuyến: ${routes?.optInt("enabled", 0) ?: 0} bật · ${routes?.optInt("disabled", 0) ?: 0} tắt"
        val redisConnected = redis?.optBoolean("connected") == true
        val subscriberConnected = redis?.optBoolean("subscriberConnected", true) != false
        val redisState = if (!redisConnected) "mất kết nối"
            else if (!subscriberConnected) "lệnh ổn, đồng bộ đang nối lại"
            else "bình thường"
        val redisLine = "Redis: $redisState"
        val updateLine = if (updatedAt.isBlank()) "" else "\nCập nhật: ${updatedAt.replace('T', ' ').take(19)}"
        status?.text = "$headline\n$routeLine\n$redisLine$updateLine"
        status?.setTextColor(if (enabled) Color.rgb(55, 224, 166) else Color.LTGRAY)
    }

    private fun buildPanel(): LinearLayout = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(10), dp(10), dp(10), dp(10))
        status = TextView(context).apply {
            text = "Đang kết nối"
            setTextColor(Color.rgb(255, 180, 60))
            setPadding(dp(6), dp(6), dp(6), dp(10))
        }
        addView(status)
        addView(button("Nhận tất cả") {
            mode = "all"
            preferences.edit().putString("mode", mode).apply()
            status?.text = "Đã chọn ${modeLabel()}"
        })
        addView(button("Cuốc ưu tiên") {
            mode = "priority"
            preferences.edit().putString("mode", mode).apply()
            status?.text = "Đã chọn ${modeLabel()}"
        })
        addView(button("START – Bắt đầu", Color.rgb(9, 150, 105)) { control("start", mode) })
        addView(button("STOP – Dừng", Color.rgb(210, 42, 79)) { confirmStop() })
        addView(button("X – Thoát", Color.rgb(70, 86, 107)) { confirmExit() })
    }

    private fun button(label: String, color: Int = Color.rgb(39, 99, 224), onClick: () -> Unit): Button =
        Button(context).apply {
            text = label
            isAllCaps = false
            setTextColor(Color.WHITE)
            setBackgroundColor(color)
            setOnClickListener { onClick() }
            layoutParams = LinearLayout.LayoutParams(dp(205), dp(48)).apply { setMargins(0, dp(4), 0, dp(4)) }
        }

    private fun attachDrag(handle: View) {
        var startX = 0
        var startY = 0
        var touchX = 0f
        var touchY = 0f
        handle.setOnClickListener {
            panel?.visibility = if (panel?.visibility == View.VISIBLE) View.GONE else View.VISIBLE
            root?.let { windowManager.updateViewLayout(it, params) }
        }
        handle.setOnTouchListener { _, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    startX = params.x
                    startY = params.y
                    touchX = event.rawX
                    touchY = event.rawY
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    params.x = startX + (event.rawX - touchX).toInt()
                    params.y = (startY + (event.rawY - touchY).toInt()).coerceAtLeast(0)
                    root?.let { windowManager.updateViewLayout(it, params) }
                    true
                }
                MotionEvent.ACTION_UP -> {
                    val moved = abs(event.rawX - touchX) + abs(event.rawY - touchY) > dp(8)
                    if (!moved) {
                        handle.performClick()
                    } else {
                        val screenWidth = context.resources.displayMetrics.widthPixels
                        params.x = if (params.x + (root?.width ?: 0) / 2 < screenWidth / 2) 0 else screenWidth - (root?.width ?: 0)
                        root?.let { windowManager.updateViewLayout(it, params) }
                        preferences.edit().putInt("overlay_x", params.x).putInt("overlay_y", params.y).apply()
                    }
                    true
                }
                else -> false
            }
        }
    }

    private fun confirmExit() {
        val dialog = AlertDialog.Builder(context)
            .setTitle("Thoát ứng dụng?")
            .setMessage("Sau khi thoát, ứng dụng sẽ không nhận được thông báo đơn mới.")
            .setNegativeButton("Hủy", null)
            .setPositiveButton("Thoát") { _, _ -> exit() }
            .create()
        dialog.window?.setType(overlayWindowType)
        dialog.show()
    }

    private fun confirmStop() {
        val dialog = AlertDialog.Builder(context)
            .setTitle("Dừng nhận đơn?")
            .setMessage("Máy chủ sẽ ngừng trả lời tin mới ngay sau khi xác nhận.")
            .setNegativeButton("Hủy", null)
            .setPositiveButton("Dừng") { _, _ -> control("stop", mode) }
            .create()
        dialog.window?.setType(overlayWindowType)
        dialog.show()
    }

    private fun modeLabel() = if (mode == "priority") "cuốc ưu tiên" else "nhận tất cả"
    private fun dp(value: Int) = (value * context.resources.displayMetrics.density).toInt()
}
