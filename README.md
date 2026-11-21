# GifX – ממיר וידאו ל-GIF

ממיר וידאו ל-GIF באיכות גבוהה, שרץ כולו בדפדפן. הקובץ לא עולה לשום שרת, ואחרי שהדף נטען לא צריך אינטרנט.

**להמרה באתר:** https://xnet2.github.io/gifx/

**לשימוש בלי אינטרנט:** מורידים את הקוד (Code → Download ZIP), פותחים את התיקייה ולוחצים פעמיים על `index.html`.

## מה יש

- חיתוך זמן (התחלה וסוף) עם ציר זמן, וחיתוך תמונה בגרירה (חופשי, 1:1, 16:9, 4:3, 9:16)
- רוחב, פריימים בשנייה (עד 50), מהירות, הפוך ובומרנג, מספר חזרות
- פלטה של עד 256 צבעים **לכל פריים בנפרד**, או פלטה אחת לכל ה-GIF
- דיזרינג: Floyd–Steinberg, Sierra, Sierra Lite, Atkinson, Bayer, או בלי, עם שליטה בעוצמה
- דחיסה בין פריימים: רק החלק שהשתנה נשמר, ופריימים זהים מתאחדים
- ההמרה רצה במקביל על כל ליבות המעבד

## איך זה עובד

1. כל פריים נלקח מהסרטון ומוקטן בשלבים (חצי בכל פעם), כדי שלא יהיה ריצוד ומדרגות.
2. פלטת הצבעים נבנית עם האלגוריתם של Wu ומשופרת עם k-means. המרחק בין צבעים מחושב בנוסחה שקרובה לאיך שהעין רואה (redmean). אם יש בפריים 256 צבעים או פחות, הם נשמרים בדיוק.
3. אחר כך יש דיזרינג (בשורות לסירוגין, serpentine) וכיווץ LZW. הכל כתוב ב-JavaScript רגיל, בלי ספריות חיצוניות.

עובד בכרום, אדג' ופיירפוקס, במחשב ובטלפון. אפשר לפתוח כל פורמט שהדפדפן מנגן (MP4, WebM, MOV ועוד).

---

**English:** GifX is a high-quality video-to-GIF converter that runs entirely in the browser. Nothing is uploaded, and there are no dependencies. Under the hood: per-frame Wu quantization with k-means refinement, perceptual color distance, error-diffusion or ordered dithering, transparency-based frame differencing, and a multi-threaded worker pool. MIT license.
