# Zalo Auto Reply

Bot Node.js phản hồi `Ok` ngay khi một người khác gửi tin nhắn vào một trong các nhóm được cho phép. React/Vite cung cấp dashboard trạng thái; bot không phụ thuộc dashboard để gửi tin.

> `zca-js` là API cá nhân không chính thức. Việc sử dụng có thể khiến tài khoản bị hạn chế/khóa. Chỉ chạy **một listener** cho tài khoản và không mở Zalo Web đồng thời.

## Chạy local

Yêu cầu Node.js 20.19+.

```bash
npm install
cp server/.env.example server/.env
# sửa ALLOWED_GROUP_IDS và ADMIN_KEY
npm run dev
```

Mở file `qr.png` do tiến trình server tạo ra để quét QR, sau đó mở `http://localhost:5173`. Sau lần quét đầu, thông tin phiên được lưu ở `data/zca-session.json` để tiến trình khởi động lại không cần quét lại.

## Cấu hình 80 nhóm

Đặt chính xác ID nhóm vào `server/.env`, phân cách bằng dấu phẩy:

```env
ALLOWED_GROUP_IDS=123456789,987654321
```

Allowlist rỗng có chủ ý sẽ không phản hồi nhóm nào. Bot bỏ qua tin do chính tài khoản gửi và chống xử lý trùng trong 60 giây.

## Build và chạy trên VPS

```bash
npm ci
npm run test
npm run build
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Lần đăng nhập đầu trên VPS, tải riêng file `qr.png` về máy để quét rồi xóa nó khỏi VPS. Không công khai file QR hoặc `data/zca-session.json` qua web.

Đặt Nginx/Caddy phía trước cổng `3001` để có HTTPS/WSS. VPS nên ở khu vực gần máy chủ Zalo và dùng kết nối ổn định; frontend không nằm trên hot path gửi tin.

## Tối ưu latency đã áp dụng

- Listener theo sự kiện, không polling.
- Kiểm tra allowlist bằng `Set` O(1).
- Không database/file I/O trên đường nhận → gửi.
- Không `await` trong callback; gọi `sendMessage` ngay.
- Một kết nối ZCA duy nhất, tiến trình PM2 luôn nóng.
- Ghi nhận latency từ lúc callback nhận sự kiện đến khi promise gửi hoàn tất.

Không thể cam kết 0 ms vì còn độ trễ mạng và thời gian xử lý phía Zalo.
