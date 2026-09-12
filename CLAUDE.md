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
- Çizim çağrısı bütçesi: kare başına < 120, üçgen bütçesi ≤ 720 bin. **Bütçe doğuş karesinde değil, EN KÖTÜ karede
  ölçülür**: {doğuş, 20 m kuzey (x=1036 z=615), 40 m kuzey (z=595)} × {12, 19, 21}, `?autostart=1&hour=H&quality=high&noadapt=1`,
  1280×720. Tur 8 yalnız doğuş karesini ölçtü ve kuzeye yürüyen kare 747,5 bin ile tavanın üstündeydi. Tur 10 değerleri
  (doğuş – 20 m – 40 m, üçgen bin / çizim): öğlen 621,9/103 – 628,9/107 – 633,9/107; 19:00 657,1/107 – 657,4/111 –
  669,8/111; 21:00 647,7/106 – 655,3/110 – 667,1/110. **En kötü 669,8 bin / 111 (19:00, 40 m kuzey.)**
  Tur 10'da orta kademe araç gövdesi (`veh:mid:*`) yeniden gölge döküyor: ölçülen bedeli +11,5 bin üçgen ve
  +4 çizim (bandda bir düzine araçla; en kötü +5, anahtar başına bir çizim). Çizim payı artık 9; yeni kalıcı mesh
  eklemeden önce bunu hesaba kat.
  **Saati ölçüm boyunca sabitle**: güneş `sunDir.y > -0.06` eşiğini ~19.05'te geçiyor ve geçtiği anda tüm gölge geçişi
  düşüyor (aynı nokta 742 bin yerine 457 bin okuyor), yani sabitlenmemiş ölçümler karşılaştırılamaz.
  Nüfus da ölçümü kaydırır: kalabalık ve trafik yavaş doluyor, tavana (40 yaya / 28 trafik) oturmuş kare aynı noktada
  ~658 bin okuyor. **Görsel bir tur kapanmadan önce dokuz kareyi de yeniden ölçüp bu satırı güncelle.**
  Karenin en büyük kalemi kalabalık (40 × 1.882 × 2 = 150,6 bin, yüzde 23): `PED_RENDER.cullDist` 96 m'dir, son
  `cullFade` 6 m'de yaya `cullFloor` (0,55) boyuna iner ve menzil dışındaki yaya listeden tamamen ÇIKAR — sıfır ölçekli
  örnek (eski 120 m kesmesinin bıraktığı şey) üçgenlerini iki geçişte birden göndermeye devam ediyordu.
  Sıradaki ucuz kalem yayalara gerçek bir LOD kademesi.
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
- Doku üretimi ana iş parçacığını bloke eder ve ilk kareden önce ödenir: sıfır argümanlı üreticilerin toplamı
  headless harness'ta ~1,03 s (yol 242 ms, lotAsphalt 172, crosswalk 151, kaldırım 99), gezinmeden ilk kareye ~7,0 s.
  `noiseWash` hedef tuvali havuzlanır (`washField`) ve eşli yıkamalar tek `getImageData`/`putImageData` paylaşır
  (~85 ms). Doku belleği artık ~113 MB GPU RGBA (mip zincirleriyle, `scratchpad/pw/texmem.mjs` ile ölçüldü) + zemin
  ailelerinin three tarafından tutulan ~23 MB CPU mip tuvali. Yeni bir 1024² zemin dokusu eklemeden önce bu satırı ölç.
- Dinamik çözünürlük: `Renderer.adapt()` fps düşerse çizim tamponunu 0.65'e kadar küçültür
  (kullanıcının kalite ayarına dokunmaz); `?noadapt=1` ile kapatılır.

## Kalite kapıları

```sh
npm run typecheck   # tsc, sıfır hata
npm run lint        # 0 hata (1 shadcn uyarısı bilinen)
npm test            # 70 birim + simülasyon testi, tarayıcı gerekmez
npm run build
npm run shot -- "http://127.0.0.1:8080/?autostart=1&hour=19" out.png   # headless ekran görüntüsü
```

Görsel değişikliklerde ekran görüntüsü alıp **bakmadan** "bitti" denmez.
Hata ayıklama URL'leri: `?autostart=1 &hour=19 &quality=low|high &seed=7 &stars=2 &nearcar=1 &debug=1`,
render kum havuzu: `/rendertest?hour=19`.

## Dil

Arayüz metinleri **Türkçe**; kod, yorum ve commit gövdesi teknik olarak açık olmalı (commit mesajları Türkçe yazılıyor).
