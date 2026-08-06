# ---------- المرحلة الأولى: البناء ----------
FROM node:24-alpine AS builder

WORKDIR /app

# ننسخ ملفات المكتبات أولاً، قبل الكود
COPY package.json package-lock.json ./

# ci بدل install: تثبيت دقيق من ملف القفل
RUN npm ci

# الآن ننسخ الكود
COPY tsconfig.json ./
COPY src ./src

# نترجم TypeScript إلى JavaScript في مجلد dist
RUN npm run build


# ---------- المرحلة الثانية: التشغيل ----------
FROM node:24-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

# مكتبات الإنتاج فقط — بدون TypeScript وبدون أدوات التطوير
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ناخد الكود المترجم فقط من المرحلة الأولى
COPY --from=builder /app/dist ./dist

# مستخدم غير جذر — أمان
USER node

EXPOSE 8080

CMD ["node", "dist/index.js"]