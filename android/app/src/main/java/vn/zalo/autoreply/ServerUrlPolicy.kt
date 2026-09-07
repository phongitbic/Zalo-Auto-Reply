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
        val host = uri.host?.removePrefix("[")?.removeSuffix("]")?.lowercase(Locale.ROOT) ?: return null
        if (uri.userInfo != null || !uri.rawQuery.isNullOrBlank() || !uri.rawFragment.isNullOrBlank()) return null
        if (!uri.rawPath.isNullOrBlank() && uri.rawPath != "/") return null
        if (scheme == "https") return input
        if (scheme != "http" || !isPrivateHost(host)) return null
        return input
    }

    private fun isPrivateHost(host: String): Boolean {
        if (host == "localhost" || host == "::1") return true
        if (host.startsWith("fc") || host.startsWith("fd")) return true
        if (Regex("^fe[89ab]").containsMatchIn(host)) return true

        val octets = host.split('.').map { it.toIntOrNull() ?: return false }
        if (octets.size != 4 || octets.any { it !in 0..255 }) return false
        val first = octets[0]
        val second = octets[1]
        return first == 10 || first == 127
            || (first == 169 && second == 254)
            || (first == 172 && second in 16..31)
            || (first == 192 && second == 168)
            || (first == 100 && second in 64..127)
    }
}
