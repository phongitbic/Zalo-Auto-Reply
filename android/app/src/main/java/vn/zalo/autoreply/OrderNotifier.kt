package vn.zalo.autoreply

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import androidx.core.app.NotificationCompat
import org.json.JSONObject

object OrderNotifier {
    private const val SEEN_EVENTS = "seen_order_events"

    @Synchronized
    fun show(context: Context, order: JSONObject, sound: Boolean, vibrate: Boolean): Boolean {
        val eventId = order.optString("eventId", order.optString("messageId"))
        if (eventId.isBlank()) return false
        val preferences = context.getSharedPreferences(OrderForegroundService.PREFERENCES, Context.MODE_PRIVATE)
        val seen = LinkedHashSet(preferences.getStringSet(SEEN_EVENTS, emptySet()) ?: emptySet())
        if (!seen.add(eventId)) return false
        while (seen.size > 200) seen.remove(seen.first())
        preferences.edit().putStringSet(SEEN_EVENTS, seen).apply()

        val channelId = "accepted_${if (sound) "sound" else "silent"}_${if (vibrate) "vibrate" else "steady"}"
        createChannel(context, channelId, sound, vibrate)
        val openApp = PendingIntent.getActivity(
            context,
            eventId.hashCode(),
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val sender = order.optString("senderName")
        val group = order.optString("groupName")
        val content = order.optString("originalContent")
        val notification = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle("ĐÃ NHẬN ĐƠN THÀNH CÔNG!")
            .setContentText("$sender · $group")
            .setStyle(NotificationCompat.BigTextStyle().bigText("$sender · $group\n$content"))
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentIntent(openApp)
            .setVibrate(if (vibrate) longArrayOf(0, 250, 120, 500) else longArrayOf(0))
            .build()
        context.getSystemService(NotificationManager::class.java).notify(eventId.hashCode(), notification)
        return true
    }

    private fun createChannel(context: Context, id: String, sound: Boolean, vibrate: Boolean) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(id) != null) return
        val channel = NotificationChannel(id, "Đơn đã nhận", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Thông báo sau khi VPS gửi OK thành công"
            enableVibration(vibrate)
            vibrationPattern = if (vibrate) longArrayOf(0, 250, 120, 500) else longArrayOf(0)
            if (sound) {
                setSound(
                    RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
                    AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).build()
                )
            } else {
                setSound(null, null)
            }
        }
        manager.createNotificationChannel(channel)
    }
}
