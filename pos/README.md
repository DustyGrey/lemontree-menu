# Lemon Tree POS

แอปขายหน้าร้าน กดเมนูแล้วกด "จบบิล" ข้อมูลจะเข้า Notion เอง ใช้ได้ทั้งมือถือ, iPad และ Mac

```
แอป (public/)  →  Cloudflare Worker (src/index.js)  →  D1 (ที่เก็บสำรอง)  →  Notion (สถิติ)
```

- ทุกบิลบันทึกลง **D1** ก่อนเสมอ แล้วค่อยส่งเข้า **Notion** ถ้าส่งไม่ผ่าน ระบบจะลองใหม่ทุก 5 นาที
- ถ้าเน็ตหลุด แอปจะเก็บบิลไว้ในเครื่องก่อน แล้วส่งให้เองเมื่อเน็ตกลับมา
- ราคาในแต่ละบิลถูกล็อกไว้ในช่อง "ราคาขาย" ถ้าแก้ราคาในตารางเมนูทีหลัง ยอดขายเก่าจะไม่เปลี่ยน
- เมนูกับราคาดึงมาจากตาราง **เมนู** ใน Notion ถ้าแก้ใน Notion แอปจะเห็นภายใน 5 นาที

## ตั้งค่าครั้งแรก (ทำครั้งเดียว)

### 1. สร้างกุญแจ Notion
1. เปิด https://www.notion.so/profile/integrations แล้วกด **New integration**
2. ตั้งชื่อ เช่น `Lemon POS` แล้วเลือก workspace **Personal** เลือกประเภท **Internal**
3. กด Save แล้วก๊อป **Internal Integration Secret** เก็บไว้ ใช้ในข้อ 3
4. เปิดหน้า **Lemon Tree House — ระบบยอดขาย** ใน Notion แล้วกด `⋯` มุมขวาบน → **Connections** → เพิ่ม `Lemon POS`

### 2. เชื่อม Cloudflare กับ GitHub
1. เข้า Cloudflare Dashboard → **Workers & Pages** → **Create** → **Import a repository**
2. เลือก repo `DustyGrey/lemontree-menu`
3. ตั้ง **Root directory** เป็น `pos` ส่วนช่องอื่นปล่อยตามค่าเดิม (Deploy command: `npx wrangler deploy`)
4. กด Deploy ครั้งแรกระบบจะสร้างฐานข้อมูล D1 ชื่อ `lemontree-sales` ให้เอง

### 3. ใส่ค่าลับ
เปิด Worker `lemontree-pos` → **Settings** → **Variables and Secrets** → เพิ่มค่าแบบ **Secret** 2 ตัว

| ชื่อ | ค่า |
|---|---|
| `NOTION_TOKEN` | กุญแจจากข้อ 1 |
| `APP_PIN` | PIN ที่ตั้งเอง ตัวเลข 4–8 หลัก |

> ห้ามใส่ค่าลับไว้ในโค้ดหรือพิมพ์ลงแชต ถ้าเปลี่ยน `APP_PIN` ทุกเครื่องต้องใส่ PIN ใหม่

### 4. ใช้งาน
- เปิดลิงก์ `https://lemontree-pos.<ชื่อบัญชี>.workers.dev` แล้วใส่ PIN
- **iPhone / iPad:** กดปุ่มแชร์ → **เพิ่มไปยังหน้าจอโฮม** จะได้ไอคอนเหมือนแอปทั่วไป
- **ยกเลิกบิล:** กดปุ่ม "บิลวันนี้" → "ยกเลิกบิลนี้" แล้วแตะซ้ำอีกครั้งเพื่อยืนยัน แถวใน Notion จะถูกย้ายไปถังขยะ กู้คืนได้
- **สรุปยอด:** กดปุ่ม "สรุปยอด" แล้วเลือกดูวันนี้ / สัปดาห์นี้ / เดือนนี้ มียอดขาย จำนวนบิล เฉลี่ยต่อบิล เทียบกับช่วงก่อนหน้า เมนูขายดี ยอดตามวันในสัปดาห์ และช่วงเวลาที่ขาย (คิดจากข้อมูลใน D1 ไม่นับบิลที่ยกเลิก)

## สำหรับนักพัฒนา

```bash
cd pos
npm install
printf 'APP_PIN=1234\nNOTION_TOKEN=secret_xxx\n' > .dev.vars   # ไฟล์นี้อยู่ใน .gitignore
npx wrangler dev
```

`NOTION_API_BASE` (ไม่บังคับ) ใช้ชี้ไปที่ Notion ปลอมตอนทดสอบในเครื่อง
