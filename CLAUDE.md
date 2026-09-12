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
- Çizim çağrısı bütçesi: kare başına < 120, üçgen bütçesi ≤ 720 bin. **Bağlayıcı kare öğlen değil, alacakaranlık ve
  gece**: doğuş karesinde (`?autostart=1&hour=12|19|21&quality=high&noadapt=1`, 1280×720) ölçülen tur 9 değerleri
  öğlen 688,5 bin / 102 çizim, 19:00 714,3 bin / 106, 21:00 713,9 bin / 105 — yani 19:00'da tavanın altında ~5,7 bin
  üçgen kalıyor. Bu sayılar ölçümdür, tahmin değil: tur 8 CLAUDE.md'ye 691/713/713 yazmıştı ama aynı komut 708/726/726
  veriyordu, yani iki kare 6 bin üstündeydi ve bir tur boyunca öyle kaldı. **Görsel bir tur kapanmadan önce 12, 19 ve
  21'i yeniden ölçüp bu satırı güncelle** (öğlen ölçmek yetmez; aradaki fark ~26 bin).
  Doğuş karesi en pahalısıdır: aynı saatte 20 m batıya yürümek 696-704 bin, diğer yakın noktalar 415-465 bin ölçüyor.
  Karenin en büyük kalemi 26 kişilik kalabalık (26 × 1.902 × 2 = 98,9 bin, yüzde 14); sıradaki ucuz kalemler ise
  `MID_CARS.cap` (16 orta kabuk, gölge geçişinde araç başına ~1 bin üçgen) ve yayalara bir LOD.
- Sahnede kalıcı olarak 3 `THREE.PointLight` (lamba havuzu, `LAMP_LIGHTS`) + 2 far SpotLight durur. Gündüz yoğunlukları
  0'dır ama sahneden çıkarılmazlar (çıkarmak `NUM_POINT_LIGHTS`'ı değiştirip tüm malzemeleri yeniden derler), yani öğlen
  de her aydınlatılan parça onları hesaplar: havuz bilerek küçük tutulur.
- Gölge kutusu (`SKY_TUNING.shadowBox`, 132 m) gölge geçişinin döküm kümesidir: her metresi renk, GTAO ve gölge
  geçişinde üç kez ödenir (150 m, alacakaranlık karesinde 120 m'ye göre ~9,5 bin üçgen demek). Kutunun sert basamaklı
  kenarını `patchShadowEdgeFade` kapatır (dıştaki yüzde 10'da gölge terimi 1'e döner), kutuyu büyütmek değil.
- Çok sayıda statik nesne (lamba, palmiye, mobilya, park kabukları, ağaç/çit) mesafeye göre paketlenir: `PropRenderer`
  malzeme başına tek `THREE.BatchedMesh` kullanır (`setVisibleAt` ile `PROP_RANGE` dışındakiler gizli) ve kamera 15 m
  hareket edince yeniden paketler (park araçlarının iki kapaklı kademesi kendi 1,5 m'lik `CAR_TIER_MOVE` ritminde,
  çünkü 8 m'lik yakın bant 15 m'lik ritimle atanamaz); `FacadeDetailRenderer` pencere çerçevesi/denizlik/balkon/klima birimlerini aynı
  şekilde ~55 m içinde tek BatchedMesh'te tutar. `WEBGL_multi_draw` gerekir.
- Dinamik çözünürlük: `Renderer.adapt()` fps düşerse çizim tamponunu 0.65'e kadar küçültür
  (kullanıcının kalite ayarına dokunmaz); `?noadapt=1` ile kapatılır.

## Kalite kapıları

```sh
npm run typecheck   # tsc, sıfır hata
npm run lint        # 0 hata (1 shadcn uyarısı bilinen)
npm test            # 66 birim + simülasyon testi, tarayıcı gerekmez
npm run build
npm run shot -- "http://127.0.0.1:8080/?autostart=1&hour=19" out.png   # headless ekran görüntüsü
```

Görsel değişikliklerde ekran görüntüsü alıp **bakmadan** "bitti" denmez.
Hata ayıklama URL'leri: `?autostart=1 &hour=19 &quality=low|high &seed=7 &stars=2 &nearcar=1 &debug=1`,
render kum havuzu: `/rendertest?hour=19`.

## Dil

Arayüz metinleri **Türkçe**; kod, yorum ve commit gövdesi teknik olarak açık olmalı (commit mesajları Türkçe yazılıyor).
