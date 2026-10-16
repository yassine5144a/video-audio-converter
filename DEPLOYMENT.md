# دليل النشر على Render.com

## 📋 المتطلبات
- حساب GitHub (لربطه بـ Render)
- حساب مجاني على [Render.com](https://render.com)

---

## 🚀 خطوات النشر

### 1. رفع المشروع على GitHub

```bash
# في مجلد المشروع (c:\Users\zgolm\Documents\convert\convert)
git init
git add .
git commit -m "Initial commit - Video to Audio Converter"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/video-audio-converter.git
git push -u origin main
```

**ملاحظة:** استبدل `YOUR_USERNAME` باسم المستخدم الخاص بك على GitHub.

---

### 2. إنشاء Web Service على Render

1. اذهب إلى [Render Dashboard](https://dashboard.render.com)
2. اضغط **"New +"** → **"Web Service"**
3. اختر **"Build and deploy from a Git repository"**
4. اربط حسابك على GitHub (إذا لم تفعل ذلك مسبقاً)
5. اختر المستودع الذي رفعته (مثل `video-audio-converter`)
6. املأ الحقول التالية:

   - **Name:** `video-converter` (أو أي اسم تريده)
   - **Region:** اختر أقرب منطقة لك
   - **Branch:** `main`
   - **Runtime:** `Docker`
   - **Instance Type:** `Free` (للتجربة)

7. اضغط **"Create Web Service"**

---

### 3. انتظر البناء

- سيستغرق البناء الأول **5-10 دقائق**
- سيقوم Render بـ:
  - تحميل الكود من GitHub
  - تثبيت FFmpeg
  - تثبيت Node.js dependencies
  - تشغيل السيرفر على المنفذ 10000

---

### 4. احصل على رابط التطبيق

بعد نجاح البناء، ستحصل على رابط مثل:
```
https://video-converter-xxxx.onrender.com
```

---

## ⚠️ ملاحظات مهمة

### 1. **التخزين المؤقت (Ephemeral Storage)**
- الملفات المرفوعة (`uploads/`, `outputs/`) **تُحذف عند إعادة تشغيل السيرفر**
- هذا طبيعي في الخطة المجانية
- الحل: سيقوم السيرفر بحذف الملفات تلقائياً بعد ساعة واحدة

### 2. **وضع السكون (Sleep Mode)**
- في الخطة المجانية، يدخل السيرفر في وضع السكون بعد **15 دقيقة** من عدم الاستخدام
- أول طلب بعد السكون سيستغرق **30-60 ثانية** لإيقاظ السيرفر
- الحل: استخدم [UptimeRobot](https://uptimerobot.com) لإرسال طلب كل 10 دقائق

### 3. **حجم الملفات**
- الحد الأقصى للرفع: **500 MB**
- إذا كنت تحتاج ملفات أكبر، ستحتاج خطة مدفوعة

### 4. **التحديثات التلقائية**
- كل مرة تقوم بـ `git push` إلى GitHub، سيعيد Render البناء تلقائياً
- لتعطيل ذلك: اذهب إلى **Settings** → **Auto-Deploy** → قم بتعطيله

---

## 🔍 استكشاف الأخطاء

### الخطأ: "Build failed"
- تأكد من وجود ملف `Dockerfile` في جذر المشروع
- تحقق من Logs في Render Dashboard

### الخطأ: "Application failed to respond"
- تأكد من أن السيرفر يستمع على `process.env.PORT` (تم إصلاحه في الكود)
- تحقق من أن المنفذ في `render.yaml` هو `10000`

### الخطأ: "FFmpeg not found"
- تأكد من أن سطر `RUN apt-get install -y ffmpeg` موجود في `Dockerfile`

---

## 🔒 الأمان (اختياري)

لإضافة حماية ضد الاستخدام المفرط، يمكنك:

### 1. تفعيل Rate Limiting
أضف في `server.js`:
```javascript
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10 // حد أقصى 10 طلبات
});

app.use('/convert', limiter);
app.use('/convert-url', limiter);
```

ثم ثبّت:
```bash
npm install express-rate-limit
```

---

## 📊 المراقبة

- عرض Logs: **Render Dashboard** → **Logs**
- عرض Metrics: **Metrics** tab (استخدام CPU/RAM)
- عرض البيئة: **Environment** tab

---

## 🎯 البدائل الأخرى

إذا لم يكن Render مناسباً:

### Railway.app
- مشابه لـ Render
- $5 رصيد مجاني شهرياً
- أسرع في البناء

### Fly.io
- خطة مجانية محدودة
- يدعم Docker
- تكوين أكثر تعقيداً

### AWS EC2 / DigitalOcean
- تحكم كامل
- تكلفة: $5-10 شهرياً
- يتطلب إعداد يدوي

---

## ✅ التحقق من النشر

بعد النشر، افتح:
```
https://your-app-name.onrender.com
```

يجب أن ترى واجهة التطبيق. حاول رفع فيديو وتحويله.

---

## 📞 الدعم

إذا واجهت مشاكل:
1. تحقق من Logs في Render Dashboard
2. تأكد من صحة ملف `Dockerfile`
3. تحقق من أن جميع dependencies مُثبتة في `package.json`

---

**🎉 تم! الآن تطبيقك يعمل على الإنترنت.**
