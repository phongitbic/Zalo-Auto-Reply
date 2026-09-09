package vn.zalo.autoreply

import java.net.URI
import java.util.Locale

object ServerUrlPolicy {
    fun normalize(value: String?): String? {
        val input = value?.trim()?.trimEnd('/') ?: return null
        if (input.isBlank()) return null

        val uri = try {
            URI(input)
        } catch (_: Exception) {
            return null
        }
        val scheme = uri.scheme?.lowercase(Locale.ROOT) ?: return null
        if (uri.host.isNullOrBlank()) return null
        if (uri.userInfo != null || !uri.rawQuery.isNullOrBlank() || !uri.rawFragment.isNullOrBlank()) return null
        if (!uri.rawPath.isNullOrBlank() && uri.rawPath != "/") return null
        if (scheme != "https" && scheme != "http") return null
        return input
    }
}
