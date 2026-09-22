package vn.zalo.autoreply

import android.app.Service
import android.content.SharedPreferences
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.TextUtils
import android.view.Gravity
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.view.WindowManager
import android.widget.Button
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import kotlin.math.abs

class OverlayController(
    private val service: Service,
    private val preferences: SharedPreferences,
    private val onControl: (String) -> Unit,
    private val onComplete: () -> Unit,
    private val onManualReply: () -> Unit,
) {
    companion object {
        const val PREFERENCE_ENABLED = "overlay_enabled"
        const val PREFERENCE_PROMPTED = "overlay_prompted"
        const val PREFERENCE_MANUAL_REPLY_ENABLED = "manual_reply_overlay_enabled"
        private const val PREFERENCE_X = "overlay_x"
        private const val PREFERENCE_Y = "overlay_y"
        private const val PREFERENCE_MANUAL_X = "manual_reply_overlay_x"
        private const val PREFERENCE_MANUAL_Y = "manual_reply_overlay_y"
    }

    private val main = Handler(Looper.getMainLooper())
    private val windowManager = service.getSystemService(WindowManager::class.java)
    private val buttonSize = dp(62)
    private val manualButtonSize = dp(54)
    private var actionButton: ImageButton? = null
    private var buttonParams: WindowManager.LayoutParams? = null
    private var manualButton: ImageButton? = null
    private var detailCard: LinearLayout? = null
    private var detailContent: TextView? = null
    private var detailMeta: TextView? = null
    private var completeButton: Button? = null
    private var status: JSONObject? = null
    private var acceptedOrder: JSONObject? = null
    private var connected = false
    private var busy = false
    private var manualBusy = false

    fun render(nextStatus: JSONObject, isConnected: Boolean) {
        val copy = JSONObject(nextStatus.toString())
        main.post {
            status = copy
            acceptedOrder = copy.optJSONObject("activeOrder")
            connected = isConnected
            sync()
        }
    }

    fun showAcceptedOrder(order: JSONObject) {
        val copy = JSONObject(order.toString())
        main.post {
            acceptedOrder = copy
            sync()
        }
    }

    fun setConnected(value: Boolean) {
        main.post {
            connected = value
            sync()
        }
    }

    fun setBusy(value: Boolean) {
        main.post {
            busy = value
            updateButton()
            updateCard()
        }
    }

    fun setManualBusy(value: Boolean) {
        main.post {
            manualBusy = value
            updateManualButton()
        }
    }

    fun refreshPermission() {
        main.post { sync() }
    }

    fun showError(message: String) {
        main.post { Toast.makeText(service, message, Toast.LENGTH_SHORT).show() }
    }

    fun destroy() {
        main.post { removeAll() }
    }

    private fun sync() {
        val controlEnabled = preferences.getBoolean(PREFERENCE_ENABLED, true)
        val manualReplyEnabled = preferences.getBoolean(PREFERENCE_MANUAL_REPLY_ENABLED, false)
        if ((!controlEnabled && !manualReplyEnabled) || !Settings.canDrawOverlays(service)) {
            removeAll()
            return
        }
        if (controlEnabled) {
            ensureButton()
            updateButton()
            if (acceptedOrder == null) removeCard() else updateCard()
        } else {
            removeCard()
            removeActionButton()
        }
        if (manualReplyEnabled) {
            ensureManualButton()
            updateManualButton()
        } else {
            removeManualButton()
        }
    }

    private fun ensureButton() {
        if (actionButton != null) return
        val metrics = service.resources.displayMetrics
        val params = WindowManager.LayoutParams(
            buttonSize,
            buttonSize,
            overlayWindowType(),
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = preferences.getInt(PREFERENCE_X, metrics.widthPixels - buttonSize - dp(16))
                .coerceIn(0, (metrics.widthPixels - buttonSize).coerceAtLeast(0))
            y = preferences.getInt(PREFERENCE_Y, dp(180))
                .coerceIn(0, (metrics.heightPixels - buttonSize).coerceAtLeast(0))
        }
        val button = ImageButton(service).apply {
            setPadding(dp(17), dp(17), dp(17), dp(17))
            scaleType = ImageView.ScaleType.CENTER_INSIDE
            elevation = dp(12).toFloat()
            setOnClickListener { handleActionClick() }
        }
        attachDrag(button, params, buttonSize, PREFERENCE_X, PREFERENCE_Y)
        try {
            windowManager.addView(button, params)
            actionButton = button
            buttonParams = params
        } catch (_: Exception) {
            actionButton = null
            buttonParams = null
        }
    }

    private fun ensureManualButton() {
        if (manualButton != null) return
        val metrics = service.resources.displayMetrics
        val params = WindowManager.LayoutParams(
            manualButtonSize,
            manualButtonSize,
            overlayWindowType(),
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = preferences.getInt(PREFERENCE_MANUAL_X, metrics.widthPixels - manualButtonSize - dp(20))
                .coerceIn(0, (metrics.widthPixels - manualButtonSize).coerceAtLeast(0))
            y = preferences.getInt(PREFERENCE_MANUAL_Y, dp(252))
                .coerceIn(0, (metrics.heightPixels - manualButtonSize).coerceAtLeast(0))
        }
        val button = ImageButton(service).apply {
            setPadding(dp(14), dp(14), dp(14), dp(14))
            scaleType = ImageView.ScaleType.CENTER_INSIDE
            elevation = dp(12).toFloat()
            setImageResource(R.drawable.ic_overlay_manual)
            contentDescription = "Nhận tay: trả lời Ok tin nhắn gần nhất"
            setOnClickListener { if (!manualBusy) onManualReply() }
        }
        attachDrag(button, params, manualButtonSize, PREFERENCE_MANUAL_X, PREFERENCE_MANUAL_Y)
        try {
            windowManager.addView(button, params)
            manualButton = button
        } catch (_: Exception) {
            manualButton = null
        }
    }

    private fun updateManualButton() {
        val button = manualButton ?: return
        button.background = roundedBackground(
            Color.parseColor("#2563EB"),
            manualButtonSize / 2f,
            Color.argb(100, 255, 255, 255),
            1,
        )
        button.alpha = if (manualBusy) 0.58f else 1f
        button.isEnabled = !manualBusy
    }

    private fun updateButton() {
        val button = actionButton ?: return
        val hasOrder = acceptedOrder != null
        val enabled = status?.optBoolean("enabled") == true
        val color: Int
        val icon: Int
        val label: String
        when {
            hasOrder -> {
                color = Color.parseColor("#2563EB")
                icon = R.drawable.ic_overlay_check
                label = "Xem đơn đã nhận"
            }
            !connected -> {
                color = Color.parseColor("#475569")
                icon = R.drawable.ic_overlay_play
                label = "Đang kết nối lại"
            }
            enabled -> {
                color = Color.parseColor("#E11D48")
                icon = R.drawable.ic_overlay_stop
                label = "Dừng nhận đơn"
            }
            else -> {
                color = Color.parseColor("#10B981")
                icon = R.drawable.ic_overlay_play
                label = "Bắt đầu nhận đơn"
            }
        }
        button.background = roundedBackground(color, buttonSize / 2f, Color.argb(90, 255, 255, 255), 1)
        button.setImageResource(icon)
        button.contentDescription = label
        button.alpha = if (busy) 0.62f else 1f
        button.isEnabled = !busy && (connected || hasOrder)
    }

    private fun handleActionClick() {
        if (busy) return
        if (acceptedOrder != null) {
            if (detailCard == null) showCard() else removeCard()
            return
        }
        if (!connected) return
        onControl(if (status?.optBoolean("enabled") == true) "stop" else "start")
    }

    private fun showCard() {
        val order = acceptedOrder ?: return
        val actionParams = buttonParams ?: return
        val metrics = service.resources.displayMetrics
        val cardWidth = dp(306)
        val root = LinearLayout(service).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(16), dp(18), dp(16))
            elevation = dp(16).toFloat()
            background = roundedBackground(Color.parseColor("#102A43"), dp(18).toFloat(), Color.parseColor("#4D8DFF"), 1)
        }
        val header = LinearLayout(service).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        header.addView(text("ĐƠN ĐÃ NHẬN", 15f, Color.parseColor("#7DB1FF"), true), LinearLayout.LayoutParams(0, -2, 1f))
        header.addView(text("×", 25f, Color.WHITE, false).apply {
            gravity = Gravity.CENTER
            setPadding(dp(12), 0, 0, 0)
            setOnClickListener { removeCard() }
        })
        root.addView(header)

        detailContent = text("", 17f, Color.WHITE, true).apply {
            maxLines = 4
            ellipsize = TextUtils.TruncateAt.END
            setPadding(0, dp(13), 0, dp(10))
        }.also { root.addView(it) }
        detailMeta = text("", 13f, Color.parseColor("#B8CAE0"), false).apply {
            setLineSpacing(0f, 1.25f)
        }.also { root.addView(it) }
        completeButton = Button(service).apply {
            text = "✓  ĐÃ XỬ LÝ"
            textSize = 14f
            setTextColor(Color.WHITE)
            isAllCaps = false
            background = roundedBackground(Color.parseColor("#2563EB"), dp(13).toFloat())
            setOnClickListener { onComplete() }
        }.also {
            root.addView(it, LinearLayout.LayoutParams(-1, dp(50)).apply { topMargin = dp(15) })
        }

        val params = WindowManager.LayoutParams(
            cardWidth,
            WindowManager.LayoutParams.WRAP_CONTENT,
            overlayWindowType(),
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = (actionParams.x + buttonSize - cardWidth)
                .coerceIn(dp(8), (metrics.widthPixels - cardWidth - dp(8)).coerceAtLeast(dp(8)))
            y = if (actionParams.y > metrics.heightPixels / 2) {
                (actionParams.y - dp(250)).coerceAtLeast(dp(8))
            } else {
                (actionParams.y + buttonSize + dp(10))
                    .coerceAtMost((metrics.heightPixels - dp(250)).coerceAtLeast(dp(8)))
            }
        }
        try {
            windowManager.addView(root, params)
            detailCard = root
            updateCard(order)
        } catch (_: Exception) {
            detailContent = null
            detailMeta = null
            completeButton = null
        }
    }

    private fun updateCard(order: JSONObject? = acceptedOrder) {
        val current = order ?: return
        detailContent?.text = current.optString("originalContent", "Không có nội dung")
        val sender = current.optString("senderName", current.optString("senderId", "--"))
        val group = current.optString("groupName", current.optString("groupId", "--"))
        val route = current.optString("matchedRoute", "Nhận tất cả")
        detailMeta?.text = "$sender · $group\n$route"
        completeButton?.isEnabled = connected && !busy
        completeButton?.alpha = if (connected && !busy) 1f else 0.55f
    }

    private fun removeCard() {
        detailCard?.let { runCatching { windowManager.removeView(it) } }
        detailCard = null
        detailContent = null
        detailMeta = null
        completeButton = null
    }

    private fun removeAll() {
        removeCard()
        removeManualButton()
        removeActionButton()
    }

    private fun removeActionButton() {
        actionButton?.let { runCatching { windowManager.removeView(it) } }
        actionButton = null
        buttonParams = null
    }

    private fun removeManualButton() {
        manualButton?.let { runCatching { windowManager.removeView(it) } }
        manualButton = null
    }

    private fun attachDrag(
        button: ImageButton,
        params: WindowManager.LayoutParams,
        size: Int,
        xPreference: String,
        yPreference: String,
    ) {
        val touchSlop = ViewConfiguration.get(service).scaledTouchSlop
        var downX = 0f
        var downY = 0f
        var startX = 0
        var startY = 0
        var dragging = false
        button.setOnTouchListener { view, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = event.rawX
                    downY = event.rawY
                    startX = params.x
                    startY = params.y
                    dragging = false
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = event.rawX - downX
                    val dy = event.rawY - downY
                    if (!dragging && (abs(dx) > touchSlop || abs(dy) > touchSlop)) {
                        dragging = true
                        removeCard()
                    }
                    if (dragging) {
                        val metrics = service.resources.displayMetrics
                        params.x = (startX + dx.toInt()).coerceIn(0, (metrics.widthPixels - size).coerceAtLeast(0))
                        params.y = (startY + dy.toInt()).coerceIn(0, (metrics.heightPixels - size).coerceAtLeast(0))
                        runCatching { windowManager.updateViewLayout(view, params) }
                    }
                    true
                }
                MotionEvent.ACTION_UP -> {
                    if (dragging) {
                        preferences.edit().putInt(xPreference, params.x).putInt(yPreference, params.y).apply()
                    } else {
                        view.performClick()
                    }
                    true
                }
                MotionEvent.ACTION_CANCEL -> true
                else -> false
            }
        }
    }

    private fun text(value: String, size: Float, color: Int, bold: Boolean) = TextView(service).apply {
        text = value
        textSize = size
        setTextColor(color)
        if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
    }

    private fun roundedBackground(color: Int, radius: Float, strokeColor: Int = Color.TRANSPARENT, strokeWidth: Int = 0) =
        GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            setColor(color)
            cornerRadius = radius
            if (strokeWidth > 0) setStroke(dp(strokeWidth), strokeColor)
        }

    private fun overlayWindowType() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
    } else {
        @Suppress("DEPRECATION")
        WindowManager.LayoutParams.TYPE_PHONE
    }

    private fun dp(value: Int) = (value * service.resources.displayMetrics.density).toInt()
}
