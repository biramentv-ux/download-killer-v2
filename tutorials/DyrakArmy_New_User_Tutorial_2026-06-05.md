# DyrakArmy New User Tutorial

Кратък tutorial за първо запознаване с платформата.

## 1. Какво е DyrakArmy
- DyrakArmy е единен web + Telegram + desktop/mobile workflow за търсене, архив, queue, streaming preview и сваляне на аудио.
- Системата пази общ sync ключ, за да се синхронизират език, формат, качество, история и Telegram mode между клиентите.

## 2. Основен web workflow
- Отвори dyrakarmy.online и постави линк или търси по име/изпълнител.
- Избери източник, формат и качество. Smart fallback може да пробва резервен mirror, когато първият източник не даде резултат.
- Натисни Queue/Download и следи статусите queued, processing, done или failed.

## 3. Архив и online player
- Раздел Архив показва локално индексираните записи, снимки и подпапки от зададения Telegram download archive.
- При готов файл може да се слуша директно през audio player без задължително сваляне.
- Търсенето първо проверява архива, после online източниците.

## 4. Telegram bot
- Ботът е на български език и поддържа настройки за език, качество, формат, captions, директни линкове и архив.
- При готово сваляне ботът може да публикува в канал и да върне линк/файл към потребителя.
- Mini App flow използва същия runtime config и sync key логика като web клиента.

## 5. Разширения и приложения
- Chrome/Firefox extension взима URL от текущия tab/context menu и го изпраща към DyrakArmy queue.
- Windows/macOS portable launchers и mobile shell трябва да четат runtime config вместо hardcoded адреси.
- Клиентите споделят език, sync key и предпочитания за формат/качество.

## 6. Надеждност и сигурност
- Worker-ът поддържа origin failover, source attempts, R2 cache, retry metadata и deterministic error shape.
- URL адресите се валидират срещу allowlist, а чувствителни стойности не трябва да се пазят в plaintext логове.
- Ops endpoints са token-protected и трябва да останат зад Cloudflare secrets.

## 7. Power features
- Shareable track cards: директни preview страници и SVG OG cards за готови job-ове.
- Artist discography: търсене, tracklist и bulk queue за дискографии/релийзи.
- Release Radar и webhook notifications: известяване при нов релийз или готово сваляне към външни системи.

## 8. Quick start checklist
- Отвори сайта и избери език.
- Задай sync key в Settings.
- Свържи Telegram бота чрез бутона Telegram.
- Пробвай един YouTube/Spotify URL и провери History/Archive.
- Инсталирай browser extension или desktop launcher само от бутоните в сайта.
