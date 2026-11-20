import SwiftUI
import WebKit

let APP_URL = URL(string: "https://yunle-music.app.workbuddy.host/?sharecode=YBAGATMDBV")!

struct WebView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        // 允许自动播放（音乐应用需要）
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsInlineMediaPlayback = true
        config.allowsPictureInPicturePlayback = true
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.allowsBackForwardNavigationGestures = true
        // 后台继续播放音频
        webView.configuration.websiteDataStore = WKWebsiteDataStore.default()
        webView.load(URLRequest(url: APP_URL))
        return webView
    }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

@main
struct YunleApp: App {
    var body: some Scene {
        WindowGroup {
            WebView()
                .ignoresSafeArea(edges: .all)
                .background(Color("AccentColor").ignoresSafeArea())
        }
    }
}
