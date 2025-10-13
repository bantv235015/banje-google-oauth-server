# ---- Giai đoạn 1: Build ----
# Sử dụng một Node.js image chính thức làm image cơ sở.
# 'alpine' là một phiên bản rất nhẹ, giúp image cuối cùng nhỏ gọn.
FROM node:18-alpine AS build

# Tạo và đặt thư mục làm việc bên trong container
WORKDIR /usr/src/app

# Sao chép các tệp quản lý dependency
# Sao chép riêng lẻ để tận dụng cache của Docker. Nếu các tệp này không đổi,
# Docker sẽ không cần chạy lại npm install ở các lần build sau.
COPY package*.json ./

# Cài đặt các dependency của dự án
RUN npm install

# Sao chép toàn bộ mã nguồn còn lại của ứng dụng vào thư mục làm việc
COPY . .

# ---- Giai đoạn 2: Production ----
# Bắt đầu một image mới, sạch sẽ cho môi trường production
FROM node:18-alpine

WORKDIR /usr/src/app

# Sao chép các dependency đã được cài đặt từ giai đoạn build
COPY --from=build /usr/src/app/node_modules ./node_modules
 
# Sao chép mã nguồn ứng dụng từ giai đoạn build
COPY --from=build /usr/src/app ./

# Expose port 3000 để cho phép kết nối từ bên ngoài container
EXPOSE 3000

# Lệnh để khởi động ứng dụng khi container chạy
CMD [ "npm", "start" ]
