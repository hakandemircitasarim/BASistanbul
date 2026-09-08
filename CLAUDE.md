# BAS İstanbul — çalışma notları

Tarayıcıda çalışan, üçüncü şahıs açık dünya araba oyunu. Three.js + TypeScript.
Ayrıntılı sözleşmeler: `docs/GAME_DESIGN.md` (bölüm 0 = temel kurallar, 2 = dondurulmuş arayüzler).

## Katman kuralları (bozulmamalı)

- **Simülasyon Three.js'siz ve React'siz**: `src/game/{core,city,entities,world,systems,missions,minimap}` ve
  `src/game/state` (yalnız `useGameStore.ts` hariç) `three` veya `react` import edemez ve **göreli** import kullanır.
  Bu sayede tüm oyun mantığı Node'da headless koşuyor (`npm test`).
- Render (`src/game/render`), ses (`src/game/audio`) ve React bileşenleri `three` kullanabilir.
- `src/game/Engine.ts` kompozisyon köküdür; sistemler onu import etmez, `EngineContext` alır.
- Tip-only importlar `import type` ile.

## Performans kuralları

- Sabit adım 1/60 s, render interpolasyonu; `fixedUpdate` ve `sync` yollarında **tahsis yok**
  (modül seviyesinde scratch nesneler, `out` parametreleri, sayaç döndüren sorgular).
- Yoğun nesneler `InstancedMesh`, statik şehir birleştirilmiş (merged) geometri.
- Çizim çağrısı bütçesi: kare başına < 120 (öğlen ~115, statik şehir ~53), üçgen bütçesi öğlen ≤ ~720 bin (şu an ~660 bin); doku belleği ~86 MB RGBA.
- Çok sayıda statik nesne (lamba, palmiye) mesafeye göre paketlenir: `PropRenderer` yalnızca
  `PROP_RANGE` içindekileri instance tamponuna yazar ve kamera 15 m hareket edince yeniden paketler.
- Dinamik çözünürlük: `Renderer.adapt()` fps düşerse çizim tamponunu 0.65'e kadar küçültür
  (kullanıcının kalite ayarına dokunmaz); `?noadapt=1` ile kapatılır.

## Kalite kapıları

```sh
npm run typecheck   # tsc, sıfır hata
npm run lint        # 0 hata (1 shadcn uyarısı bilinen)
npm test            # 64 birim + simülasyon testi, tarayıcı gerekmez
npm run build
npm run shot -- "http://127.0.0.1:8080/?autostart=1&hour=19" out.png   # headless ekran görüntüsü
```

Görsel değişikliklerde ekran görüntüsü alıp **bakmadan** "bitti" denmez.
Hata ayıklama URL'leri: `?autostart=1 &hour=19 &quality=low|high &seed=7 &stars=2 &nearcar=1 &debug=1`,
render kum havuzu: `/rendertest?hour=19`.

## Dil

Arayüz metinleri **Türkçe**; kod, yorum ve commit gövdesi teknik olarak açık olmalı (commit mesajları Türkçe yazılıyor).
