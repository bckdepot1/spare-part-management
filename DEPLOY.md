# Deploy ขึ้น Cloudflare Pages (ฟรี)

ทำหลังจากตั้งค่า Supabase เสร็จแล้ว (ดู [`SUPABASE_SETUP.md`](SUPABASE_SETUP.md))

## 1. สร้าง repo บน GitHub

1. เข้า **https://github.com/new**
2. ตั้งชื่อ repo เช่น `spare-part-management` เลือก **Private** หรือ **Public** ก็ได้ (ไม่ต้องติ๊ก "Add README")
3. กด **Create repository** — หน้าที่ได้จะมีคำสั่ง git ให้คัดลอก (จะใช้ในขั้นตอนถัดไป)

## 2. Push โค้ดขึ้น GitHub

โค้ดถูกเตรียม git commit ไว้ในเครื่องแล้ว เปิด terminal ที่โฟลเดอร์โปรเจกต์นี้ (`D:\620051\Desktop\Claude\Spare part`) แล้วรัน (แทน `<URL>` ด้วย URL ของ repo ที่เพิ่งสร้าง เช่น `https://github.com/yourname/spare-part-management.git`):

```bash
git remote add origin <URL>
git branch -M main
git push -u origin main
```

ครั้งแรกที่ push เครื่องจะถามให้ล็อกอิน GitHub (เปิดเบราว์เซอร์ให้ยืนยันตัวตน) — ทำตามได้เลย

## 3. เชื่อม Cloudflare Pages กับ repo

1. เข้า **Cloudflare Dashboard** → **Workers & Pages** → **Create** → แท็บ **Pages** → **Connect to Git**
2. เลือก repo `spare-part-management` ที่เพิ่ง push ไป
3. ตั้งค่า build:
   - **Framework preset**: `None`
   - **Build command**: เว้นว่างไว้ (ไม่ต้อง build — เป็น static HTML/JS ล้วน)
   - **Build output directory**: `/` (root ของ repo)
4. กด **Save and Deploy**

รอสัก 1-2 นาที Cloudflare จะให้ URL แบบ `https://spare-part-management.pages.dev` — เข้าใช้งานได้เลย

## 4. อัปเดตเว็บในอนาคต

ทุกครั้งที่แก้โค้ดแล้ว push ขึ้น `main` branch (`git push`) Cloudflare Pages จะ build/deploy ให้อัตโนมัติ ไม่ต้องทำอะไรเพิ่ม

## หมายเหตุเรื่องความปลอดภัย

`config.js` ที่มี anon key จะถูก push ขึ้น GitHub ไปด้วย — **ปกติและตั้งใจให้เป็นแบบนั้น** เพราะ anon key ถูกออกแบบมาให้อยู่ในโค้ด frontend ที่เปิดเผยได้อยู่แล้ว การป้องกันจริงอยู่ที่ Row Level Security ในฐานข้อมูล (`db/schema.sql`) ไม่ใช่การซ่อนคีย์นี้

ถ้าจะใช้โดเมนของตัวเอง (เช่น `spm.บริษัทคุณ.co.th`) ทำได้ที่ Cloudflare Pages → โปรเจกต์ → **Custom domains** — แจ้งมาได้ถ้าต้องการให้ช่วยตั้งค่า DNS
