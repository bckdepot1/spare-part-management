# ตั้งค่า Supabase (ทำครั้งเดียว)

ทำตามลำดับนี้ในบัญชี Supabase ที่สมัครไว้ ใช้เวลาประมาณ 10 นาที

## 1. สร้างโปรเจกต์

1. เข้า **https://supabase.com/dashboard** → **New project**
2. ตั้งชื่อโปรเจกต์ (เช่น `spare-part-management`)
3. ตั้ง **Database Password** — จดเก็บไว้ (ใช้เผื่อกรณีต้องต่อฐานข้อมูลตรงๆ ในอนาคต ไม่ได้ใช้ในเว็บนี้)
4. เลือก Region ที่ใกล้ที่สุด (เช่น Singapore) → **Create new project** รอสักครู่ให้โปรเจกต์พร้อมใช้งาน

## 2. รัน schema (สร้างตาราง + สิทธิ์การเข้าถึง)

1. ในเมนูซ้าย เลือก **SQL Editor** → **New query**
2. เปิดไฟล์ [`db/schema.sql`](db/schema.sql) ในโปรเจกต์นี้ คัดลอกทั้งหมดไปวาง
3. กด **Run**
4. เปิดไฟล์ [`db/seed_stock.sql`](db/seed_stock.sql) คัดลอกทั้งหมดไปวางในแท็บ query ใหม่ → **Run**
   (นี่คือขั้นตอนที่ใส่ข้อมูลอะไหล่ทั้ง 143 รายการเข้าไป)

## 3. ปิด "Confirm email"

ระบบนี้ใช้ชื่อผู้ใช้แบบสั้น (เช่น `admin`) ไม่ใช่อีเมลจริง จึงต้องปิดการยืนยันอีเมล ไม่งั้นสมัครสมาชิกใหม่จะค้างที่ขั้นตอนยืนยัน:

1. **Authentication** (เมนูซ้าย) → **Providers** → **Email**
2. ปิดสวิตช์ **Confirm email**
3. กด **Save**

## 4. สร้างบัญชีเดโม 3 บัญชี

1. **Authentication** → **Users** → **Add user** → **Create new user**
2. สร้างทีละบัญชี ตามตารางนี้ (Auto Confirm User: **เปิด**ไว้ทุกบัญชี):

   | Email | Password |
   |---|---|
   | `admin@login.spareapart.internal` | ตั้งรหัสผ่านเอง (จำไว้) |
   | `supervisor@login.spareapart.internal` | ตั้งรหัสผ่านเอง |
   | `operator@login.spareapart.internal` | ตั้งรหัสผ่านเอง |

   ผู้ใช้จะพิมพ์แค่ `admin` / `supervisor` / `operator` ในหน้าล็อกอินของเว็บ — ส่วน `@login.spareapart.internal` เป็นส่วนที่ระบบเติมให้อัตโนมัติ ไม่ต้องบอกใคร

3. กลับไปที่ **SQL Editor** → เปิดไฟล์ [`db/promote_seed_users.sql`](db/promote_seed_users.sql) → วาง → **Run**
   (ขั้นตอนนี้ตั้งสิทธิ์ Admin/Supervisor/Operator ให้ตรงกับบัญชี และเปิดใช้งานทันที)

## 5. เอา URL + anon key มาใส่ในเว็บ

1. **Project Settings** (ไอคอนเฟือง) → **API**
2. คัดลอกค่า **Project URL** และ **anon public** key
3. เปิดไฟล์ [`config.js`](config.js) ในโปรเจกต์นี้ แก้ 2 บรรทัด:

   ```js
   window.SPM_CONFIG = {
     url: 'https://xxxxxxxxxxxx.supabase.co',   // ← Project URL
     anonKey: 'eyJhbGciOiJIUzI1NiIs...'           // ← anon public key
   };
   ```

4. บันทึกไฟล์ แล้วเปิดเว็บใหม่ — ควรล็อกอินด้วย `admin` / `supervisor` / `operator` ได้ทันที

> **anon key ไม่ใช่ความลับ** ออกแบบมาให้ฝังในโค้ด frontend ได้อยู่แล้ว ทุกตารางถูกล็อกด้วย Row Level Security (ดูใน `db/schema.sql`) แต่ **ห้ามใช้ "service_role" key** ในไฟล์นี้เด็ดขาด — คีย์นั้นข้าม RLS ได้ทั้งหมด ต้องเก็บไว้ในหน้า Dashboard เท่านั้น

## ตรวจสอบว่าเสร็จสมบูรณ์

- [ ] รัน `db/schema.sql` แล้ว (ไม่มี error สีแดง)
- [ ] รัน `db/seed_stock.sql` แล้ว — ไปที่ **Table Editor → stock** ควรเห็น 143 แถว
- [ ] ปิด "Confirm email" แล้ว
- [ ] สร้างผู้ใช้ 3 บัญชีใน Authentication → Users แล้ว
- [ ] รัน `db/promote_seed_users.sql` แล้ว — ควรเห็นผลลัพธ์ 3 แถวที่มี role/status ถูกต้อง
- [ ] แก้ `config.js` ใส่ URL + anon key แล้ว
- [ ] ล็อกอินเข้าเว็บได้จริง เห็นรายการอุปกรณ์ 143 รายการ
