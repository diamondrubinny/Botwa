# Power Apps / Power Automate / Power BI

Botwa חושף REST API עם תיאור בפורמט OpenAPI 2.0 (Swagger), הפורמט שמחברים מותאמים (Custom connectors) של Microsoft מייבאים.
שלבי הייבוא בממשק של Power Apps מבוססים על הממשק המוכר לי, ודורשים אימות מול התיעוד הרשמי של Microsoft. הם משתנים מעת לעת.

## יצירת המחבר
1. **מפתח:** בפאנל ← אינטגרציות ← "מפתח חדש". הרשאת `read` לקריאה, ו-`send` אם האפליקציה תשלח תשובות ללקוחות. את המפתח מעתיקים פעם אחת. אחר כך הוא לא מוצג שוב.
2. **הגדרות:** מורידים את `https://<השרת>/api/v1/openapi.json` (או מהכפתור בעמוד האינטגרציות).
3. **ב-Power Apps** (make.powerapps.com): Dataverse / More ← Custom connectors ← New custom connector ← Import an OpenAPI file.
4. **אבטחה:** Authentication type = API Key, Parameter label = "Botwa key", Parameter name = `Authorization`, Location = Header.
5. Create connector, ואז Test ← New connection ← מדביקים `Bearer bk_...` (המילה Bearer, רווח, והמפתח). מריצים את `WhoAmI` לבדיקה.

## פעולות זמינות
| פעולה | מה מחזיר | הרשאה |
|---|---|---|
| `WhoAmI` | שם המפתח וההרשאות | read |
| `GetStats(days)` | שיחות חדשות, הודעות, זמני מענה, עמידה ב-SLA, מגמה יומית, תגיות נפוצות | read |
| `ListConversations(status, updated_since, limit, offset)` | שיחות, החדשות קודם | read |
| `GetConversation(id)` / `ListMessages(id, after_seq)` | שיחה והודעות | read |
| `ListContacts(q, limit, offset)` | אנשי קשר (נרשם ביומן הביקורת) | read |
| `ListFaq()` | שאלות ותשובות ממאגר הידע | read |
| `ListTags()` / `ListUsers()` | תגיות וצוות | read |
| `SendReply(id, text)` | תשובה בשיחה קיימת (חלים כללי החסימה וחלון המענה) | send |

**דוגמאות ב-Power Fx:**
- גלריה של שיחות פתוחות: `Botwa.ListConversations({status: "open", limit: 100}).items`
- כרטיס מדד: `Botwa.GetStats({days: 7}).newConversations`

**Power BI:** אפשר לקרוא ל-`/api/v1/stats` ול-`/api/v1/conversations` מ-Web connector עם כותרת `Authorization`. מומלץ להשתמש במפתח נפרד עם `read` בלבד.

## אבטחה ופרטיות
- **מפתח לכל שימוש:** מפתח נפרד לכל אפליקציה, עם ההרשאה המינימלית. מפתח שדלף מבטלים מיד בעמוד האינטגרציות.
- **איפה שומרים את המפתח:** רק בחיבור (Connection) של Power Platform, לא בקוד או בנוסחאות של האפליקציה.
- **מידע אישי:** אנשי קשר והודעות הם מידע אישי. מי שמשתף את האפליקציה ב-Power Apps חושף אותם למשתמשי האפליקציה, ולכן צריך לשתף רק עם מי שמורשה. **דורש בדיקה** מול מדיניות הארגון, וייתכן שגם DPA מול Microsoft.
- **מגבלת קצב:** לכל מפתח יש מגבלת קריאות לדקה. קריאה מעבר לה מקבלת 429.
