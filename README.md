# Zalo Auto Reply

Hệ thống nhận tin nhắn nhóm bằng Socket của Zalo và gửi `@Tên người gửi Ok` qua HTTP Keep-Alive. Bot chạy độc lập trên máy chủ; web/Android chỉ điều khiển và nhận sự kiện sau khi Zalo xác nhận gửi thành công.

> `zca-js` là API cá nhân không chính thức. Tài khoản có thể bị hạn chế hoặc khóa. Chỉ chạy một listener cho tài khoản và không mở Zalo Web đồng thời.

## Thành phần

- `server/`: Bun 1.4 + Elysia, Socket.IO chạy trên Bun Engine, QR đăng nhập và trạng thái bot trên máy chủ.
- `client/`: React/Vite, giao diện web và bundle dùng trong Capacitor.
- `android/`: ứng dụng Android native, foreground service, thông báo và TTS.

Entry production duy nhất là `server/src/index.js`, chạy bằng Bun và Elysia. Không chạy hai instance vì sẽ tạo hai listener cho cùng tài khoản Zalo.

Ba trạng thái nhận đơn được lưu tại máy chủ:

- `STOPPED`: listener vẫn sống nhưng không trả lời tin mới.
- `ALL`: trả lời mọi tin hợp lệ trong nhóm cho phép.
- `PRIORITY`: chỉ trả lời khi nội dung khớp tuyến đang bật.

`ORDER_ACCEPTED` chỉ được phát sau khi lệnh gửi Zalo hoàn tất thành công. Tin đến có từ `Ok`, tin trùng, sai nhóm hoặc không khớp tuyến không tạo thông báo nhận đơn.

## Chạy và kiểm thử local

Yêu cầu Bun 1.4.1 trở lên; build Android cần thêm JDK 21 và Android SDK.

```powershell
irm bun.sh/install.ps1 | iex
bun install --frozen-lockfile
Copy-Item server/.env.example server/.env
bun test
bun run build
bun run dev
```

Trước khi chạy, điền ít nhất `ALLOWED_GROUP_IDS` và `ADMIN_KEY` trong `server/.env`. `ADMIN_KEY` phải là chuỗi ngẫu nhiên từ 32 ký tự; cấu hình production sẽ từ chối khởi động nếu khóa trống, ngắn hoặc còn giá trị mẫu cũ.

Có thể tạo khóa trên chính máy triển khai bằng PowerShell rồi tự chép kết quả vào `.env`:

```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
```

Không commit `server/.env`, khóa ký Android, file QR hoặc session Zalo.

## Cấu hình VPS

Các biến quan trọng nằm trong [server/.env.example](server/.env.example):

- `ALLOWED_GROUP_IDS`: ID nhóm, phân cách bằng dấu phẩy.
- `CLIENT_ORIGINS`: origin web/Capacitor được phép kết nối.
- `SESSION_FILE` và `QR_FILE`: session cùng QR đăng nhập được bảo vệ trên VPS.
- `BOT_STATE_FILE`: lưu START/STOP và chế độ hiện tại.
- `MAX_SOCKET_CONNECTIONS`: giới hạn client đồng thời cho một instance.
- `KEEP_ALIVE_INTERVAL_MS`: heartbeat Zalo, mặc định và tối thiểu 5 giây.
- `GROUP_PRECONNECT_INTERVAL_MS`: chuẩn bị sẵn DNS/TCP/TLS tới đúng host gửi nhóm, mặc định 1 giây. Backend cũng preconnect ngay trước mỗi lần gửi; không tạo request API Zalo giả.
- `REDIS_URL`: địa chỉ Redis 5, mặc định `redis://127.0.0.1:6379`; nếu có `requirepass` dùng `redis://:MAT_KHAU_URL_ENCODED@127.0.0.1:6379`.
- `REDIS_PREFIX`: tiền tố khóa khi nhiều ứng dụng dùng chung Redis.
- `REDIS_CHANNEL`: kênh Pub/Sub đồng bộ cấu hình, mặc định `priority_routes_updated`.
- `REDIS_CONNECT_TIMEOUT_MS`: thời gian chờ mỗi lần mở socket Redis, mặc định 5 giây.
- `REDIS_PING_INTERVAL_MS`: gửi PING định kỳ để NAT/firewall không cắt socket Redis nhàn rỗi, mặc định 10 giây.

Redis Server 5 được hỗ trợ trực tiếp bằng RESP2. Không cần nâng Redis chỉ để chạy ứng dụng này. Trên Ubuntu 20.04, cài và bật gói Redis của hệ điều hành:

```bash
sudo apt update
sudo apt install -y redis-server
sudo systemctl enable --now redis-server
redis-cli -h 127.0.0.1 ping
redis-cli -h 127.0.0.1 INFO server | grep redis_version
```

Trong `/etc/redis/redis.conf`, cấu hình phù hợp khi Redis và bot cùng VPS là:

```conf
bind 127.0.0.1
protected-mode yes
port 6379
timeout 0
tcp-keepalive 60
supervised systemd
```

Sau khi sửa, chạy `sudo systemctl restart redis-server`. `redis-cli` phải trả về `PONG`. Giữ `REDIS_URL=redis://127.0.0.1:6379`, không dùng IP công khai và không mở cổng 6379 ra Internet. Redis 5 chưa có ACL username; nếu đã bật `requirepass`, URL phải để trống username như ví dụ ở trên và mật khẩu chứa ký tự đặc biệt phải được URL-encode.

Kiểm tra đúng toàn bộ nhóm lệnh và Pub/Sub mà ứng dụng cần bằng chính cấu hình trong `server/.env`:

```bash
bun --version
sudo systemctl status redis-server --no-pager
redis-cli -h 127.0.0.1 ping
bun run --cwd server redis:check
pm2 logs zalo-auto-reply --lines 100
```

Server cần Bun `1.4.1` trở lên. `ECONNREFUSED` thường là dịch vụ chưa chạy hoặc sai host/cổng; `NOAUTH`/`WRONGPASS` là sai `requirepass`; lỗi `unknown command HELLO` cho biết tiến trình vẫn đang chạy code cũ chưa ép RESP2. Hệ thống chỉ dùng các lệnh có trong Redis 5: `GET`, `SET`, `DEL`, `INCR`, `MULTI/EXEC`, `ZADD`, `ZRANGEBYSCORE`, `ZREMRANGEBYSCORE`, `PING`, `PUBLISH` và `SUBSCRIBE`. Khi Redis tạm mất kết nối, bot tiếp tục dùng cấu hình gần nhất trong RAM và tự nối lại; mất riêng Pub/Sub không còn bị báo nhầm là mất kênh lệnh và bot tuyệt đối không tự chuyển từ `PRIORITY` sang `ALL`.

### Kết nối Android với máy chủ

Không cần có website hay tên miền khi điện thoại và máy chạy backend ở cùng mạng Wi-Fi. Trong ứng dụng Android, nhập địa chỉ IP LAN của máy chạy backend theo dạng `http://192.168.1.10:3001` và nhập `ADMIN_KEY` trong `server/.env`. Không nhập `localhost`, vì trên điện thoại địa chỉ đó là chính điện thoại chứ không phải máy tính.

Backend phải lắng nghe trên `0.0.0.0`, và tường lửa của máy chủ phải cho phép điện thoại truy cập cổng `3001` trong mạng riêng. Ứng dụng cho phép HTTP với IP LAN (`10.x`, `172.16-31.x`, `192.168.x`), loopback, link-local và IP Tailscale `100.64-127.x`; HTTP tới IP Internet công cộng bị từ chối để tránh lộ token quản trị.

Nếu điện thoại kết nối qua Internet công cộng, hãy đặt Nginx/Caddy trước cổng `3001` để dùng HTTPS/WSS, hoặc đưa điện thoại và máy chủ vào cùng mạng riêng Tailscale. Địa chỉ máy chủ vẫn bắt buộc trên Android: token chỉ dùng để xác thực, không chứa thông tin vị trí của backend.

### QR đăng nhập

Khi session chưa có hoặc hết hạn, server chuyển sang `qr_required`, lưu QR riêng trong `server/data/` và cung cấp ảnh qua `/api/zalo/qr` có Bearer token. Sau khi đăng nhập thành công, QR bị xóa và session được lưu lại. Không public thư mục `server/data` qua reverse proxy.

### Tuyến và bí danh địa chỉ

Mỗi dòng trong file `.txt` là một tuyến theo đúng dạng `Điểm đi | Điểm đến`:

```text
Bắc Ninh | Hà Nội
Bắc Ninh | Quảng Ninh
Võ Cường, Bắc Ninh | Cầu Giấy, Hà Nội
```

Giao diện luôn hiển thị bản xem trước và số dòng lỗi trước khi xác nhận. File có một dòng sai sẽ không thay đổi cấu hình đang chạy. Mỗi tuyến chỉ nhận đúng chiều từ điểm đi tới điểm đến; muốn nhận chiều ngược phải tạo một tuyến riêng. Điểm đi và điểm đến là bắt buộc. Giá tiền và từ khóa bị loại là hai bộ lọc không bắt buộc: nếu khai báo giá, tin nhắn phải chứa ít nhất một giá đã nhập; nếu chứa bất kỳ từ khóa bị loại nào thì bot không trả lời. Có thể nhập nhiều giá hoặc từ khóa, ngăn cách bằng dấu phẩy, dấu chấm phẩy hoặc xuống dòng.

Bộ lọc chuẩn hóa chữ hoa/thường, dấu tiếng Việt, dấu câu và khoảng trắng một lần trong RAM. File TXT chỉ dùng lúc nhập; không có thao tác đọc file hoặc tải toàn bộ Redis trên đường xử lý từng tin nhắn.

## Chạy production bằng PM2

Trên Ubuntu 20.04, cài Bun và dependency khóa bởi `bun.lock`:

```bash
sudo apt update
sudo apt install -y curl unzip
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
cd /duong-dan/zalo-auto-reply
bun install --frozen-lockfile
bun test
bun run build
```

Nếu VPS đã có PM2, bảo đảm `bun` có trong `PATH` của shell rồi chạy:

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 status
curl -fsS http://127.0.0.1:3001/health
```

Nếu PM2 đang giữ định nghĩa tiến trình cũ cùng tên, chuyển chắc chắn sang entry Bun bằng một lần dừng ngắn; lệnh `pm2 delete` chỉ xóa định nghĩa tiến trình, không xóa `.env`, session hay dữ liệu:

```bash
pm2 delete zalo-auto-reply
pm2 start ecosystem.config.cjs
pm2 save
```

Nếu chưa có PM2, có thể cài bằng `bun add --global pm2`; sau đó chạy `pm2 startup` và thực thi đúng lệnh PM2 in ra để tự khởi động cùng hệ điều hành. `ecosystem.config.cjs` dùng `interpreter: "bun"` và entry `server/src/index.js`.

Nếu PowerShell báo `bun` hoặc `pm2` không được nhận diện, đóng/mở lại terminal sau khi cài và kiểm tra `C:\Users\<tên-user>\.bun\bin` đã nằm trong `PATH`. Windows không có init system như Linux; nếu dùng Windows làm server, hãy tạo Task Scheduler chạy `pm2 resurrect` khi đăng nhập.

Sau khi cập nhật code:

```bash
bun install --frozen-lockfile
bun test
bun run build
pm2 startOrRestart ecosystem.config.cjs --update-env
pm2 status
pm2 logs zalo-auto-reply --lines 100
curl -fsS http://127.0.0.1:3001/health
```

Dùng `startOrRestart` thay vì chạy hai tiến trình song song: một tài khoản chỉ được có một Zalo listener. Đây là cập nhật gần như không gián đoạn nhưng tránh nguy cơ hai bot cùng trả lời một tin.

### Chạy bằng systemd, không cần PM2

Tạo `/etc/systemd/system/zalo-auto-reply.service` và thay `User`, `WorkingDirectory`, `ExecStart` bằng đường dẫn thật:

```ini
[Unit]
Description=Zalo Auto Reply (Bun + Elysia)
After=network-online.target redis-server.service
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/zalo-auto-reply
Environment=NODE_ENV=production
ExecStart=/home/ubuntu/.bun/bin/bun --no-env-file server/src/index.js
Restart=always
RestartSec=2
TimeoutStopSec=12
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now zalo-auto-reply
sudo systemctl status zalo-auto-reply --no-pager
journalctl -u zalo-auto-reply -n 100 --no-pager
```

## Hợp đồng API và realtime

Tất cả API `/api/*` yêu cầu `Authorization: Bearer <ADMIN_KEY>` hoặc `x-admin-key`. `GET /health` chỉ trả `{ "status": "ok" }` và không tiết lộ cấu hình.

| Method | Path | Kết quả chính |
| --- | --- | --- |
| GET | `/health` | Health check 200 |
| GET | `/api/status` | Snapshot bot, mode, tuyến, Redis và timings |
| GET | `/api/bootstrap` | `{ status }` để web/APK đồng bộ trạng thái ban đầu |
| GET | `/api/zalo/qr` | Ảnh QR không cache hoặc JSON 404 |
| POST | `/api/bot/control` | `{ action: "start"|"stop", mode: "all"|"priority" }` |
| POST | `/api/bot/enabled` | Tương thích client cũ với `{ enabled }` |
| POST | `/api/bot/priority-only` | Tương thích client cũ với `{ enabled }` |
| POST | `/api/settings/priority-routes/preview` | Kiểm tra file TXT, không thay đổi cấu hình |
| POST | `/api/settings/priority-routes/import` | Nhập file TXT, trả 201 khi hợp lệ |
| POST | `/api/settings/priority-routes` | Thêm một tuyến, trả 201 |
| PATCH | `/api/settings/priority-routes` | Bật/tắt toàn bộ tuyến |
| PATCH | `/api/settings/priority-routes/:id` | Sửa một tuyến |
| DELETE | `/api/settings/priority-routes/:id` | Xóa một tuyến |
| GET | `/api/settings/priority-routes/export` | Tải JSON tuyến dưới dạng attachment |

Dashboard và APK tiếp tục kết nối Socket.IO tại `/socket.io/`, chỉ dùng transport `websocket`, token nằm trong `auth.token` hoặc header `x-admin-key`. Bun Engine chính chủ của Socket.IO được gắn trực tiếp vào Elysia nên client không cần đổi giao thức. Khi kết nối, server gửi `status`; trong lúc chạy phát `status`, `stats`, `redis`, `qr`, `ORDER_ACCEPTED` và `ORDER_FAILED`. Sự kiện nội bộ `decision` chỉ dùng cho log khi bật `HOT_PATH_LOGGING`.

Nhóm Zalo hiện được quản lý duy nhất bởi `ALLOWED_GROUP_IDS` trong `.env`; migration không tự thêm API nhóm mới để tránh đổi hành vi production.

## Kết quả xác minh

Backend chỉ có một đường production Bun + Elysia. Test bao phủ API, auth, Socket.IO, mode, tuyến, dedupe, Redis coordinator, giới hạn body và HTTP Keep-Alive native. React/Vite build thành công; Capacitor sync và APK release đã được kiểm tra với chữ ký APK Signature Scheme v2 hợp lệ.

Luồng yêu cầu/tạo QR thật trên Bun đã thành công. Redis local có thể kiểm tra bằng `bun run --cwd server redis:check`; trên VPS Redis 5 cũng dùng đúng lệnh này để xác nhận dịch vụ và mật khẩu thật.

Các file migration chính:

- `server/src/index.js`: entry Bun/Elysia và graceful shutdown.
- `server/src/bun-app.js`: ghép Elysia, CORS, static web và health check.
- `server/src/api-routes.js`: toàn bộ HTTP API giữ nguyên contract.
- `server/src/realtime.js`: Bun Engine + Socket.IO tương thích web/APK.
- `server/src/backend-runtime.js`: bot, store, Redis và mutation tuần tự.
- `server/src/auth.js`: Bearer/x-admin-key constant-time.
- `bun.lock`: dependency lock production.

## Android

Ứng dụng dùng đúng các quyền phục vụ kết nối mạng, foreground service `remoteMessaging`, thông báo/rung và overlay. Quyền thông báo và overlay được hỏi lúc dùng chức năng tương ứng. Token không nằm trong APK hoặc Android WebView localStorage; người dùng nhập lúc cài đặt và native service mã hóa token bằng Android Keystore.

### Debug

Cài JDK 21 và Android SDK Platform 36/Build Tools 36, tạo `android/local.properties` trỏ tới SDK, rồi chạy:

```powershell
bun run android:debug
```

APK debug nằm tại `android/app/build/outputs/apk/debug/app-debug.apk`.

### Release đã ký

Để tạo keystore dài hạn lần đầu, chạy:

```powershell
.\scripts\create-release-keystore.ps1
bun run android:release
```

Script tạo `android/signing/zalo-auto-reply-release.jks` và `android/signing.properties`; cả hai đều bị Git bỏ qua. Hãy sao lưu an toàn cả hai file. Mất keystore hoặc mật khẩu sẽ không thể ký bản cập nhật cùng danh tính ứng dụng.

Nếu đã có keystore riêng, có thể dùng bốn biến môi trường thay cho `signing.properties`:

```powershell
$env:ANDROID_KEYSTORE_PATH='đường-dẫn-tuyệt-đối-tới-keystore'
$env:ANDROID_KEYSTORE_PASSWORD='mật-khẩu-keystore'
$env:ANDROID_KEY_ALIAS='alias'
$env:ANDROID_KEY_PASSWORD='mật-khẩu-key'
bun run android:release
```

Build release cố ý thất bại nếu không có cấu hình ký cục bộ hoặc thiếu biến ký để không tạo nhầm APK chưa ký. APK nằm tại `android/app/build/outputs/apk/release/app-release.apk`.

## Kiến trúc độ trễ thấp

- Zalo Socket nhận sự kiện; không polling tin nhắn.
- `fetch` native của Bun tự dùng connection pooling và HTTP Keep-Alive; heartbeat không chiếm một pool nhỏ riêng nên không xếp hàng trước lệnh gửi.
- Allowlist dùng `Set`; tuyến đã chuẩn hóa nằm trong RAM.
- Bộ dò tuyến dùng cây token và chỉ mục ngược, nên không quét toàn bộ 5.000 tuyến cho mỗi tin.
- Dedupe diễn ra trước khi so tuyến; các message gần nhất được khôi phục từ Redis và lịch sử sau restart.
- Không chờ ghi file, dashboard hay Android trước khi gửi Zalo.
- Heartbeat không chồng lặp, có timeout; listener tự reconnect theo backoff.
- Socket app có xác thực, heartbeat, timeout, reconnect và đồng bộ trạng thái/lịch sử sau khi nối lại.

Không thể cam kết 0 ms vì vẫn phụ thuộc mạng và máy chủ Zalo. Các chỉ số `normalizationMs`, `routeMatchMs`, `dispatchMs`, `networkMs` và `totalMs` tách rõ thời gian xử lý local khỏi thời gian mạng.

Có thể đo lại đường xử lý local độc lập với mạng bằng `bun run --cwd server benchmark`. Đo HTTP của server đang chạy bằng `bun run --cwd server benchmark:http http://127.0.0.1:3001`.

Sau khi VPS có thêm đơn thật, phân tích tối đa 100 lần gửi gần nhất bằng:

```bash
bun run --cwd server latency:report -- 100
```

Báo cáo tách `total`, `zaloNetwork`, `dispatch`, các lần gửi liên tiếp và lần gửi sau ít nhất 60 giây không hoạt động. Chỉ cân nhắc proxy sau khi có tối thiểu 50 mẫu; so sánh `p50`, `p95`, `p99` thay vì chọn theo lần nhanh nhất.
