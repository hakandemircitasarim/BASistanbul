# BAS İstanbul — Büyük Araba Soygunu

Tarayıcıda çalışan, üçüncü şahıs, açık dünya bir "GTA tarzı" oyun temeli. Prosedürel olarak üretilen,
Vice City havasında bir sahil şehrinde yürür, koşar, park halindeki arabaları çalıp sürer, trafiğin ve
yayaların arasında dolaşır, aranma seviyesi kazanıp polisten kaçar ve kısa görevler yaparsınız.
Tüm görseller ve sesler prosedüreldir (hazır model, doku veya ses dosyası yoktur).

## Neler var?

- **Şehir**: 10×10 blokluk ızgara, ~360 bina (art-deco sahil, cam gökdelenli merkez, banliyö), plajlar, okyanus,
  iskele ve dönme dolap, Turuncu Kule, arena, hastane, polis merkezi, park ve plazalar; ~1300 sokak lambası, ~500 palmiye.
- **Oyuncu**: WASD ile kameraya göre hareket, koşma, zıplama, fare ile kamera (işaretçi kilidi) veya Q/R ile klavye kamerası.
- **Araçlar**: sedan, spor, kamyonet, taksi, polis; arcade fizik (hız bağımlı direksiyon, el freniyle drift, hasar, farlar).
- **Trafik ve yayalar**: şerit grafı üzerinde süren araçlar, dur işaretli kavşaklar, kaldırımlarda dolaşan ve tehlikede kaçan yayalar.
- **Aranma sistemi**: 0–5 yıldız; yaya veya araç çarpmak yıldız kazandırır, polis A* ile yol bulup kovalar, yakalar ("YAKALANDIN").
- **HUD**: mini harita, can/zırh, para, yıldızlar, hız göstergesi, bağlamsal istek ("E - Araca bin"), görev metni, bildirimler.
- **Görevler**: Sahil Yürüyüşü, Turuncu Kurye, Sıcak Takip (plazalardaki turuncu işaretlere girerek başlar).
- **Gece/gündüz**: 10 dakikalık gün döngüsü; gün batımında neonlar, pencereler, lambalar ve farlar yanar.
- **Ses**: WebAudio ile sentezlenen motor, korna, siren, dalga sesi, çarpma ve arayüz sesleri.

## Kontroller

| Tuş | İşlev |
|---|---|
| W A S D | Hareket / direksiyon |
| Shift | Koş |
| Boşluk | Zıpla (yaya) / El freni (araç) |
| E | Araca bin / araçtan in / görevi başlat |
| H | Korna |
| L | Farlar |
| V | Kamera mesafesi |
| Q / R | Kamera (fare kilidi yokken) |
| M | Sessiz |
| Esc | Duraklat |
| F3 | Hata ayıklama paneli |

## Çalıştırma

```sh
npm install
npm run dev        # http://localhost:8080
```

Diğer komutlar:

```sh
npm run build      # production derlemesi (dist/)
npm run typecheck  # tsc
npm run lint       # eslint
npm test           # birim + headless simülasyon testleri (tsx, tarayıcı gerekmez)
npm run test:unit  # yalnızca *.test.ts
npm run test:sim   # yalnızca *.sim.ts (trafik, polis, görev simülasyonları)
npm run shot -- "http://127.0.0.1:8080/?autostart=1&hour=19" out.png   # headless ekran görüntüsü (playwright-core + Chromium gerekir)
```

Hata ayıklama için URL seçenekleri: `?autostart=1` (menüyü atla), `?hour=19`, `?quality=low|high`, `?seed=7`,
`?stars=2` (aranma seviyesi), `?nearcar=1` (en yakın park halindeki arabanın yanında başla), `?debug=1`.
`/rendertest?hour=19` sayfası şehir render katmanını motor olmadan gösterir.

## Mimari

Tasarım ve sözleşmeler `docs/GAME_DESIGN.md` dosyasındadır. Kısaca:

- `src/game/core` — matematik, RNG, olay yolu, girdi, uzamsal hash, SAT çarpışma, sabit adımlı oyun döngüsü.
- `src/game/city` — yol/şerit grafı, kaldırım grafı, prosedürel şehir üreteci ve doğrulayıcı.
- `src/game/entities`, `world`, `systems`, `missions` — Three.js'ten bağımsız simülasyon (Node'da headless çalışır).
- `src/game/render` — Three.js render katmanı (instancing/merge, gökyüzü, efektler), `src/game/audio` — WebAudio.
- `src/game/state` + `src/components/game` — 10 Hz'de yayınlanan HUD durumu ve React arayüzü.
- `src/game/Engine.ts` — kompozisyon kökü: faz makinesi, sistem sırası, render karesi.
