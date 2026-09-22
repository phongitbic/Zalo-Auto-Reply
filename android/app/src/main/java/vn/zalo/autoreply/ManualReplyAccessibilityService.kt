package vn.zalo.autoreply

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.graphics.Rect
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.lang.ref.WeakReference
import java.text.Normalizer
import java.util.ArrayDeque
import java.util.Locale

class ManualReplyAccessibilityService : AccessibilityService() {
    companion object {
        private const val ZALO_PACKAGE = "com.zing.zalo"

        @Volatile
        private var activeService: WeakReference<ManualReplyAccessibilityService>? = null

        fun isReady(): Boolean = activeService?.get() != null

        fun requestReply(onFinished: () -> Unit): Boolean {
            val service = activeService?.get() ?: return false
            service.replyToLatestIncoming(onFinished)
            return true
        }
    }

    private data class VisibleNode(
        val node: AccessibilityNodeInfo,
        val text: String,
        val normalizedText: String,
        val bounds: Rect,
    )

    private val main = Handler(Looper.getMainLooper())
    private var busy = false

    override fun onServiceConnected() {
        super.onServiceConnected()
        activeService = WeakReference(this)
    }

    override fun onDestroy() {
        if (activeService?.get() === this) activeService = null
        main.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit

    override fun onInterrupt() = Unit

    private fun replyToLatestIncoming(onFinished: () -> Unit) {
        if (busy) {
            onFinished()
            return
        }
        val root = zaloRoot() ?: return onFinished()
        val nodes = visibleNodes(root)
        val composer = findComposer(nodes) ?: return onFinished()
        if (!composer.text.isNullOrBlank() || !isGroupConversation(nodes)) return onFinished()
        val message = findLatestIncoming(nodes, composer.bounds.top) ?: return onFinished()

        busy = true
        val finish = {
            busy = false
            onFinished()
        }
        if (performLongClick(message.node)) {
            main.postDelayed({ chooseReplyAction(finish) }, 90L)
        } else {
            dispatchLongPress(message.bounds, finish)
        }
    }

    private fun zaloRoot(): AccessibilityNodeInfo? {
        val activeRoot = rootInActiveWindow
        if (activeRoot?.packageName?.toString() == ZALO_PACKAGE) return activeRoot
        return windows.asSequence()
            .filter { it.isActive || it.isFocused }
            .mapNotNull { it.root }
            .firstOrNull { it.packageName?.toString() == ZALO_PACKAGE }
    }

    private fun visibleNodes(root: AccessibilityNodeInfo): List<VisibleNode> {
        val result = ArrayList<VisibleNode>()
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        while (queue.isNotEmpty()) {
            val node = queue.removeFirst()
            if (node.isVisibleToUser) {
                val text = node.text?.toString()?.trim().orEmpty()
                val description = node.contentDescription?.toString()?.trim().orEmpty()
                val searchable = listOf(text, description, node.viewIdResourceName.orEmpty())
                    .filter { it.isNotBlank() }
                    .joinToString(" ")
                val bounds = Rect().also(node::getBoundsInScreen)
                result.add(VisibleNode(node, text, normalize(searchable), bounds))
            }
            for (index in 0 until node.childCount) node.getChild(index)?.let(queue::addLast)
        }
        return result
    }

    private fun findComposer(nodes: List<VisibleNode>): VisibleNode? {
        val screenHeight = resources.displayMetrics.heightPixels
        return nodes.asSequence()
            .filter {
                (it.node.isEditable || it.node.className?.toString()?.endsWith("EditText") == true) &&
                    it.bounds.top > screenHeight / 2 && it.bounds.height() > 0
            }
            .maxByOrNull { it.bounds.bottom }
    }

    private fun isGroupConversation(nodes: List<VisibleNode>): Boolean {
        val screenHeight = resources.displayMetrics.heightPixels
        return nodes.any { entry ->
            entry.bounds.top < screenHeight / 3 && (
                Regex("\\b\\d+\\s*(thanh vien|members?)\\b").containsMatchIn(entry.normalizedText) ||
                    Regex("\\b\\d+\\s*nguoi\\b").containsMatchIn(entry.normalizedText) ||
                    entry.normalizedText.contains("thong tin nhom") ||
                    entry.normalizedText.contains("group_info") ||
                    entry.normalizedText.contains("group chat")
                )
        }
    }

    private fun findLatestIncoming(nodes: List<VisibleNode>, composerTop: Int): VisibleNode? {
        val width = resources.displayMetrics.widthPixels
        val height = resources.displayMetrics.heightPixels
        val topLimit = (height * 0.16f).toInt()
        val bottomLimit = composerTop - dp(8)
        return nodes.asSequence()
            .filter { entry ->
                entry.text.isNotBlank() &&
                    entry.bounds.height() > 0 &&
                    entry.bounds.top >= topLimit &&
                    entry.bounds.bottom <= bottomLimit &&
                    entry.bounds.left < width * 0.30f &&
                    entry.bounds.centerX() < width * 0.58f &&
                    isMessageText(entry.normalizedText)
            }
            .maxByOrNull { it.bounds.bottom }
    }

    private fun isMessageText(value: String): Boolean {
        if (value.isBlank() || value.length > 2_000) return false
        if (Regex("^\\d{1,2}:\\d{2}([ :]?(am|pm))?$").matches(value)) return false
        return value !in setOf(
            "tra loi", "gui", "tin nhan", "nhap tin nhan", "them", "anh", "camera",
            "thu am", "goi dien", "goi video", "tuy chon", "quay lai",
        )
    }

    private fun performLongClick(node: AccessibilityNodeInfo): Boolean {
        var current: AccessibilityNodeInfo? = node
        repeat(5) {
            val candidate = current ?: return false
            if (candidate.isLongClickable && candidate.performAction(AccessibilityNodeInfo.ACTION_LONG_CLICK)) {
                return true
            }
            current = candidate.parent
        }
        return false
    }

    private fun dispatchLongPress(bounds: Rect, onFinished: () -> Unit) {
        val path = Path().apply { moveTo(bounds.centerX().toFloat(), bounds.centerY().toFloat()) }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0L, 520L))
            .build()
        val dispatched = dispatchGesture(gesture, object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) {
                main.postDelayed({ chooseReplyAction(onFinished) }, 90L)
            }

            override fun onCancelled(gestureDescription: GestureDescription?) = onFinished()
        }, null)
        if (!dispatched) onFinished()
    }

    private fun chooseReplyAction(onFinished: () -> Unit, attemptsLeft: Int = 4) {
        val root = zaloRoot() ?: return onFinished()
        val reply = visibleNodes(root)
            .filter { it.normalizedText == "tra loi" || it.normalizedText.startsWith("tra loi ") }
            .maxByOrNull { it.bounds.bottom }
        if (reply == null) {
            if (attemptsLeft > 0) {
                main.postDelayed({ chooseReplyAction(onFinished, attemptsLeft - 1) }, 60L)
            } else {
                onFinished()
            }
            return
        }
        if (!performClick(reply.node)) return onFinished()
        main.postDelayed({ enterAndSend(onFinished) }, 60L)
    }

    private fun enterAndSend(onFinished: () -> Unit, attemptsLeft: Int = 4) {
        val root = zaloRoot() ?: return onFinished()
        val nodes = visibleNodes(root)
        val composer = findComposer(nodes)
        if (composer == null) {
            if (attemptsLeft > 0) {
                main.postDelayed({ enterAndSend(onFinished, attemptsLeft - 1) }, 50L)
            } else {
                onFinished()
            }
            return
        }
        if (!composer.text.isNullOrBlank()) return onFinished()

        val arguments = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, "Ok")
        }
        composer.node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        if (!composer.node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)) return onFinished()
        main.postDelayed({ clickSend(onFinished) }, 40L)
    }

    private fun clickSend(onFinished: () -> Unit, attemptsLeft: Int = 4) {
        val root = zaloRoot() ?: return onFinished()
        val width = resources.displayMetrics.widthPixels
        val height = resources.displayMetrics.heightPixels
        val send = visibleNodes(root).asSequence()
            .filter {
                it.bounds.left > width * 0.60f &&
                    it.bounds.top > height / 2 &&
                    (it.normalizedText == "gui" ||
                        it.normalizedText.startsWith("gui ") ||
                        it.normalizedText.contains("btn_send") ||
                        it.normalizedText.contains("button_send"))
            }
            .maxByOrNull { it.bounds.bottom }
        if (send != null) {
            performClick(send.node)
            onFinished()
        } else if (attemptsLeft > 0) {
            main.postDelayed({ clickSend(onFinished, attemptsLeft - 1) }, 40L)
        } else {
            onFinished()
        }
    }

    private fun performClick(node: AccessibilityNodeInfo): Boolean {
        var current: AccessibilityNodeInfo? = node
        repeat(5) {
            val candidate = current ?: return false
            if (candidate.isClickable && candidate.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true
            current = candidate.parent
        }
        return false
    }

    private fun normalize(value: String): String = Normalizer.normalize(value, Normalizer.Form.NFD)
        .replace("\\p{M}+".toRegex(), "")
        .lowercase(Locale.ROOT)
        .replace("đ", "d")
        .replace(Regex("\\s+"), " ")
        .trim()

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
}
