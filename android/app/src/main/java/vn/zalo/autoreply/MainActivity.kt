package vn.zalo.autoreply

import android.os.Bundle
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(OrderServicePlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
