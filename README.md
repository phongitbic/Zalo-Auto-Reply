# Zalo Auto Reply

Hệ thống nhận tin nhắn nhóm bằng Socket của Zalo và gửi `@Tên người gửi Ok` qua HTTP Keep-Alive. Bot chạy độc lập trên VPS; web/Android chỉ điều khiển và nhận sự kiện sau khi Zalo xác nhận gửi thành công.

> `zca-js` là API cá nhân không chính thức. Tài khoản có thể bị hạn chế hoặc khóa. Chỉ chạy một listener cho tài khoản và không mở Zalo Web đồng thời.

## Thành phần

- `server/`: Node.js, Socket.IO, QR đăng nhập, trạng thái bot và lịch sử đơn trên VPS.
- `client/`: React/Vite, giao diện web và bundle dùng trong Capacitor.
- `android/`: ứng dụng Android native, foreground service, thông báo, TTS và nút nổi.

Ba trạng thái nhận đơn được lưu tại VPS:

- `STOPPED`: listener vẫn sống nhưng không trả lời tin mới.
- `ALL`: trả lời mọi tin hợp lệ trong nhóm cho phép.
- `PRIORITY`: chỉ trả lời khi nội dung khớp tuyến đang bật.

`ORDER_ACCEPTED` chỉ được phát sau khi lệnh gửi Zalo hoàn tất thành công. Tin đến có từ `Ok`, tin trùng, sai nhóm hoặc không khớp tuyến không tạo thông báo nhận đơn.

## Chạy và kiểm thử local

Yêu cầu Node.js 22+ nếu cần build Android/Capacitor; riêng server hỗ trợ Node.js 20.19+.

```powershell
npm install
Copy-Item server/.env.example server/.env
npm test
npm run build
npm run dev
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
- `ORDER_HISTORY_FILE`: lịch sử các đơn Zalo đã xác nhận gửi thành công để đồng bộ lại app.
- `MAX_SOCKET_CONNECTIONS`: giới hạn client đồng thời cho một instance.
- `KEEP_ALIVE_INTERVAL_MS`: heartbeat Zalo, tối thiểu 5 giây.
- `HTTP_CONNECTIONS`: số kết nối tối đa trong cùng HTTP Keep-Alive pool; mặc định 4 để heartbeat không chặn lệnh gửi.
- `REDIS_URL`: địa chỉ Redis, mặc định `redis://127.0.0.1:6379`.
- `REDIS_PREFIX`: tiền tố khóa khi nhiều ứng dụng dùng chung Redis.
- `REDIS_CHANNEL`: kênh Pub/Sub đồng bộ cấu hình, mặc định `priority_routes_updated`.
- `REDIS_CONNECT_TIMEOUT_MS`: thời gian chờ mỗi lần mở socket Redis, mặc định 5 giây.
- `REDIS_PING_INTERVAL_MS`: gửi PING định kỳ để NAT/firewall không cắt socket Redis nhàn rỗi, mặc định 10 giây.

Redis là nguồn cấu hình chính thức. Trên Ubuntu 20.04, nên dùng kho gói chính thức của Redis rồi bật dịch vụ bằng systemd:

```bash
sudo apt-get update
sudo apt-get install -y lsb-release curl gpg
curl -fsSL https://packages.redis.io/gpg | sudo gpg --dearmor -o /usr/share/keyrings/redis-archive-keyring.gpg
sudo chmod 644 /usr/share/keyrings/redis-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/redis-archive-keyring.gpg] https://packages.redis.io/deb $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/redis.list
sudo apt-get update
sudo apt-get install -y redis
sudo systemctl enable --now redis-server
redis-cli -h 127.0.0.1 ping
```

`redis-cli` phải trả về `PONG`. Khi Redis và bot ở cùng VPS, giữ đúng `REDIS_URL=redis://127.0.0.1:6379`; không dùng IP công khai và không mở cổng 6379 ra Internet. Dùng `127.0.0.1` cũng tránh trường hợp `localhost` trỏ sang IPv6 trong khi Redis chỉ bind IPv4. Nếu Redis ở máy khác, dùng tài khoản/mật khẩu trong URL và `rediss://` cho TLS.

Kiểm tra đúng toàn bộ nhóm lệnh và Pub/Sub mà ứng dụng cần bằng chính cấu hình trong `server/.env`:

```bash
node -v
sudo systemctl status redis-server --no-pager
redis-cli -h 127.0.0.1 ping
npm run redis:check -w server
pm2 logs zalo-auto-reply --lines 100
```

Server cần Node.js `20.19.0` trở lên. `ECONNREFUSED` thường là dịch vụ chưa chạy hoặc sai host/cổng; `NOAUTH`/`WRONGPASS` là sai xác thực; `NOPERM` là tài khoản ACL thiếu quyền lệnh, khóa hoặc kênh Pub/Sub. Hệ thống dùng các khóa `zalo-auto-reply:bot:state`, `zalo-auto-reply:priority:routes`, `zalo-auto-reply:priority:config_version`, `zalo-auto-reply:processed:messages` và các khóa heartbeat theo tiến trình. Khi Redis tạm mất kết nối, bot tiếp tục dùng cấu hình gần nhất trong RAM và tự nối lại; mất riêng Pub/Sub không còn bị báo nhầm là mất kênh lệnh và bot tuyệt đối không tự chuyển từ `PRIORITY` sang `ALL`.

Đặt Nginx hoặc Caddy trước cổng `3001` để cung cấp HTTPS/WSS. Android cố ý từ chối URL HTTP và manifest chặn cleartext traffic.

### QR đăng nhập

Khi session chưa có hoặc hết hạn, server chuyển sang `qr_required`, lưu QR riêng trong `server/data/` và cung cấp ảnh qua `/api/zalo/qr` có Bearer token. Sau khi đăng nhập thành công, QR bị xóa và session được lưu lại. Không public thư mục `server/data` qua reverse proxy.

### Tuyến và bí danh địa chỉ

Mỗi dòng trong file `.txt` là một tuyến theo đúng dạng `Điểm đi | Điểm đến`:

```text
Bắc Ninh | Hà Nội
Bắc Ninh | Quảng Ninh
Võ Cường, Bắc Ninh | Cầu Giấy, Hà Nội
```

Giao diện luôn hiển thị bản xem trước và số dòng lỗi trước khi xác nhận. File có một dòng sai sẽ không thay đổi cấu hình đang chạy. Tuyến nhập mới mặc định bật và nhận hai chiều; có thể sửa điểm đi, điểm đến, trạng thái, chiều đi và tên thay thế riêng trên giao diện. Các chữ viết tắt như `BN`, `HN` chỉ được dùng khi người quản trị khai báo, bot không tự suy diễn.

Bộ lọc chuẩn hóa chữ hoa/thường, dấu tiếng Việt, dấu câu và khoảng trắng một lần trong RAM. File TXT chỉ dùng lúc nhập; không có thao tác đọc file hoặc tải toàn bộ Redis trên đường xử lý từng tin nhắn.

## Chạy production bằng PM2

```powershell
npm ci
npm test
npm run build
npm install --global pm2
pm2 start ecosystem.config.cjs
pm2 save
```

Trên VPS Linux, chạy thêm `pm2 startup` rồi thực thi đúng lệnh PM2 in ra để tự khởi động cùng hệ điều hành. Windows không có init system tương ứng; nếu dùng Windows làm server, hãy tạo Task Scheduler chạy `pm2 resurrect` khi đăng nhập.

Nếu PowerShell báo `pm2 is not recognized`, đóng/mở lại terminal sau khi cài. Có thể kiểm tra thư mục binary bằng `npm config get prefix`, hoặc chạy ngay bằng `npx pm2 start ecosystem.config.cjs` rồi `npx pm2 save`.

Sau khi cập nhật code:

```powershell
npm ci
npm test
npm run build
pm2 restart ecosystem.config.cjs --update-env
pm2 status
pm2 logs zalo-auto-reply --lines 100
```

## Android

Ứng dụng dùng đúng các quyền phục vụ kết nối mạng, foreground service `remoteMessaging`, thông báo/rung và overlay. Quyền thông báo và overlay được hỏi lúc dùng chức năng tương ứng. Token không nằm trong APK hoặc Android WebView localStorage; người dùng nhập lúc cài đặt và native service mã hóa token bằng Android Keystore.

### Debug

Cài JDK 21 và Android SDK Platform 36/Build Tools 36, tạo `android/local.properties` trỏ tới SDK, rồi chạy:

```powershell
npm run android:debug
```

APK debug nằm tại `android/app/build/outputs/apk/debug/app-debug.apk`.

### Release đã ký

Để tạo keystore dài hạn lần đầu, chạy:

```powershell
.\scripts\create-release-keystore.ps1
npm run android:release
```

Script tạo `android/signing/zalo-auto-reply-release.jks` và `android/signing.properties`; cả hai đều bị Git bỏ qua. Hãy sao lưu an toàn cả hai file. Mất keystore hoặc mật khẩu sẽ không thể ký bản cập nhật cùng danh tính ứng dụng.

Nếu đã có keystore riêng, có thể dùng bốn biến môi trường thay cho `signing.properties`:

```powershell
$env:ANDROID_KEYSTORE_PATH='đường-dẫn-tuyệt-đối-tới-keystore'
$env:ANDROID_KEYSTORE_PASSWORD='mật-khẩu-keystore'
$env:ANDROID_KEY_ALIAS='alias'
$env:ANDROID_KEY_PASSWORD='mật-khẩu-key'
npm run android:release
```

Build release cố ý thất bại nếu không có cấu hình ký cục bộ hoặc thiếu biến ký để không tạo nhầm APK chưa ký. APK nằm tại `android/app/build/outputs/apk/release/app-release.apk`.

## Kiến trúc độ trễ thấp

- Zalo Socket nhận sự kiện; không polling tin nhắn.
- Một HTTP Agent/Keep-Alive pool giữ kết nối sống; tối đa 4 kết nối tránh heartbeat hoặc nhiều đơn đồng thời chặn nhau.
- Allowlist dùng `Set`; tuyến đã chuẩn hóa nằm trong RAM.
- Bộ dò tuyến dùng cây token và chỉ mục ngược, nên không quét toàn bộ 5.000 tuyến cho mỗi tin.
- Dedupe diễn ra trước khi so tuyến; các message gần nhất được khôi phục từ Redis và lịch sử sau restart.
- Không chờ ghi file, dashboard hay Android trước khi gửi Zalo.
- Heartbeat không chồng lặp, có timeout; listener tự reconnect theo backoff.
- Socket app có xác thực, heartbeat, timeout, reconnect và đồng bộ trạng thái/lịch sử sau khi nối lại.

Không thể cam kết 0 ms vì vẫn phụ thuộc mạng và máy chủ Zalo. Các chỉ số `normalizationMs`, `routeMatchMs`, `dispatchMs`, `networkMs` và `totalMs` tách rõ thời gian xử lý local khỏi thời gian mạng.

Có thể đo lại đường xử lý local độc lập với mạng bằng `npm run benchmark -w server`.
