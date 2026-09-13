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
  1280×720. Tur 8 yalnız doğuş karesini ölçtü ve kuzeye yürüyen kare 747,5 bin ile tavanın üstündeydi. Tur 12'nin
  KAPANIŞINDA dokuz karenin hepsi yeniden ölçüldü (`scratchpad/pw/dv-worst.mjs <base>`, saat sabit, nüfus doyana
  kadar bekleme: 40 yaya / 26-28 trafik) ve tur 11'in tablosuyla **tamı tamına** aynı çıktı — yani tur 12'nin
  değişiklikleri (gölge haritası 3072, temas lekesinin sıra numarası, `plain`/`glow`'un probe listesinden çıkması)
  üçgen ve çizim açısından nötr (doğuş – 20 m – 40 m, üçgen bin / çizim): öğlen 656,2/105 – 674,3/107 –
  666,9/107; 19:00 684,7/109 – **703,6**/111 – 703,1/111; 21:00 688,0/108 – 702,1/110 – 700,9/110.
  **En kötü 703.626 üçgen / 111 çizim (19:00, 20 m kuzey.)**
  Tabloyu 1280×720 dışında bir görüntü alanıyla ÖLÇME: bir tur-11 eleştirmeni aynı kareyi 640×360'ta 707.466 okudu
  ve tavana kalan payı 3,9 bin fazla gösterdi; LOD/paketleme kararları kare yüksekliğine bağlı.
  **Bağlayıcı KONUM değişti**: 19:00'da da 21:00'de de en kötü kare artık 40 m değil **20 m kuzey**; yalnız eski
  noktayı örnekleyen bir tur yanlış kareyi ölçer. Tavana kalan pay 16,4 bin üçgen (tur 10'un yazdığı ~50 bin değil)
  ve 9 çizim. Tur 10'da orta kademe araç gövdesi (`veh:mid:*`) yeniden gölge döküyor: ölçülen bedeli +11,5 bin üçgen
  ve +4 çizim (bandda bir düzine araçla; en kötü +5, anahtar başına bir çizim). Yeni kalıcı mesh eklemeden önce bunu
  hesaba kat.
  **Saati ölçüm boyunca sabitle**: güneş `sunDir.y > -0.06` eşiğini ~19.05'te geçiyor ve geçtiği anda tüm gölge geçişi
  düşüyor (aynı nokta 742 bin yerine 457 bin okuyor), yani sabitlenmemiş ölçümler karşılaştırılamaz.
  Nüfus da ölçümü kaydırır: kalabalık ve trafik yavaş doluyor, tavana (40 yaya / 28 trafik) oturmuş kare aynı noktada
  ~658 bin okuyor. **Görsel bir tur kapanmadan önce dokuz kareyi de yeniden ölçüp bu satırı güncelle.**
  Karenin en büyük kalemi kalabalık (40 × 1.926 × 2 = 154,1 bin, yüzde 22 — yaya başına 1.926, eski satırın yazdığı
  1.882 değil; sahnedeki altı `ped:part` örnekli mesh'i toplayarak ölçüldü): `PED_RENDER.cullDist` 96 m'dir, son
  `cullFade` 6 m'de yaya `cullFloor` (0,55) boyuna iner ve menzil dışındaki yaya listeden tamamen ÇIKAR — sıfır ölçekli
  örnek (eski 120 m kesmesinin bıraktığı şey) üçgenlerini iki geçişte birden göndermeye devam ediyordu.
  Sıradaki ucuz kalem yayalara gerçek bir LOD kademesi.
- Sahnede kalıcı olarak 3 `THREE.PointLight` (lamba havuzu, `LAMP_LIGHTS`) + 2 far SpotLight durur. Gündüz yoğunlukları
  0'dır ama sahneden çıkarılmazlar (çıkarmak `NUM_POINT_LIGHTS`'ı değiştirip tüm malzemeleri yeniden derler), yani öğlen
  de her aydınlatılan parça onları hesaplar: havuz bilerek küçük tutulur.
- **Gölge haritası `SKY_TUNING.shadowMap` = 3072 ve bedeli VRAM'dir.** three, PCF yönlü gölgeyi
  `new WebGLRenderTarget(w,h)` (hiç örneklenmeyen bir RGBA8 renk eki) **artı** `DepthTexture(w,h,UnsignedIntType)`
  olarak kurar, yani teksel başına **8 bayt**: 2048'de 33,6 MB, 3072'de **75,5 MB**, 4096'da 134,2 MB. (Canlı
  ölçüldü: `sun.shadow.map` 4096², doku biçimi 1023/tip 1009, derinlik tipi 1014 — `scratchpad/pw/rev-shmem.mjs`.)
  Tur 11 4096'yı aldı ve bedeli "4096² derinlik eki" diye, yani yarısı kadar yazdı. Bu kalem üçgen/çizim
  sayacında GÖRÜNMEZ; bütçe tablosu onu ölçmez, **aşağıdaki doku belleği satırıyla birlikte** hesaplanmalı.
  Tur 12 3072'ye indi: saat 15'te ışığa dik temas karesinde, karenin yaya içermeyen sağ yarısında 4096'ya karşı
  piksellerin yalnız %0,99'u 8/255'ten, %0,04'ü 20/255'ten fazla değişiyor (2048 için aynı sayılar %2,27 ve %0,33).
  Yani 3072, 4096'nın 2048 üstüne kattığının ~%88'ini, kattığı belleğin %42'sine alıyor; kalan fark bir gölge
  KONTURUNUN keskinliği (fark maskesi yalnız çit ve direk gölgesi kenarlarında yanıyor), figürün şekil okuyup
  okumaması değil. `shadow.normalBias` tekselden türetilir (SkySystem'deki yoruma bak): harita değişirse o da değişir.
- **`material.envMapIntensity` bu projede ÖLÜDÜR**: probe `scene.environment` üzerinde yaşıyor ve three her çizimde
  `scene.environmentIntensity`'yi (1) o uniforma yazıyor. `SURF`'ün `env` sütunu yalnız `Materials.probeScale` ile
  shader'a bağlanan aileler için gerçek. **Probe kesmesi albedo telafisiyle birlikte gelir** (`applyGroundLift`,
  GROUND_DAY_LIFT 1,22); telafisiz kesme tek taraflı kayıptır — tur 11 `plain`/`glow`'u listeye koydu ve şehrin
  bütün çatı hattı harpuştasını 12,8/255 söndürdü (tur 12'de geri alındı). `plain` = çatı trim mesh'i + arka plan
  tepeleri, kaldırım taşı veya prop kabuğu DEĞİL.
- Temas lekesi (`ContactShadows`) bir ÇARPIMDIR (`dst *= 1 - srcAlpha`) ve `renderOrder` = **1,5**: yol boyası ve
  fren izinin (1) ÜSTÜNDE — ikisi de derinlik yazmaz, altta kalırsa boya çarpımın üstüne tam parlaklıkta yeniden
  basılır — ama her toplamalı katmanın (lamba havuzu 2, neon 3, işaret 4, parçacık 5-6) ALTINDA.
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
  (~85 ms). Doku belleği tur 11'de **114,2 MB** GPU RGBA (mip zincirleriyle, `scratchpad/pw/texmem.mjs` ile ölçüldü)
  + zemin ailelerinin three tarafından tutulan **24 MB** CPU mip tuvali olarak ölçüldü (tur 10 `roadMarks`'ı 256'dan
  512'ye çıkardı, +1,0 MB). Yeni bir 1024² zemin dokusu eklemeden önce bu satırı ölç. **`quality=high`'da toplam GPU
  belleği bu 114,2 MB değil**: üstüne gölge haritasının 75,5 MB'ı (yukarıdaki madde), PMREM ortam haritası ve
  besteci hedefleri (HDR renk + GTAO + bloom) biner. Gölgeler yalnız `high`'da açıktır (`Renderer.ts` applySettings),
  yani 75,5 MB yalnız o kademede ödenir.
- Dinamik çözünürlük: `Renderer.adapt()` fps düşerse çizim tamponunu 0.65'e kadar küçültür
  (kullanıcının kalite ayarına dokunmaz); `?noadapt=1` ile kapatılır.

## Şehir ve sürüş değişmezleri (tur 11'de düzeltildi)

- `ContactShadows.groundYAt` hücre indeksini **kaldırım önlüğü içeride** alır
  (`Math.floor((x - ROAD_W + SIDEWALK_W) / PITCH)`). Blok yükseltisi `[bx - SIDEWALK_W, bx + BLOCK + SIDEWALK_W]`;
  önlük katılmazsa her bloğun düşük-x / düşük-z yüzü bir önceki hücreye düşer, dikdörtgen testi kalır ve 0 döner —
  park araçlarının yarısı (1316'nın 676'sı) kaldırıma binmeden düz duruyordu, yaya/oyuncu da o şeritlerde 15 cm gömülüyordu.
  `kerbStance`, yaya/oyuncu/araç lekesi ve oyuncu mesh yüksekliği hep bu fonksiyondan besleniyor.
- Park şeridi kaldırım şeridinde DEĞİL, kaldırıma binerek dış trafik şeridinde durur (`KERB_PARK`: flank
  `SIDEWALK_W + roadLap` = 3,45 m, dış şerit gövde zarfına pay `laneClear` = 0,30 m). Bu yüzden siren kenara çekilmesi
  dış şeritte `kerbSafeYieldOffset` ile 0,30 m'ye kırpılır (tam 1,0 m park aracının içine 0,70 m girerdi) ve
  `validateCity`'nin çarpışan-şerit kuralı **yalnız** park aracı ayak izleri için gevşetilir; geri kalan her şey
  `LANE_W / 2` kuralında kalır.
- `vehicle:collision` kıvılcımı `FX_TUNING.sparkMinImpact` (1,5 m/s) altında hiç atılmaz: 4 kıvılcımlık taban,
  şehir genelinde dakikada birkaç kez olan ~0,1 m/s'lik sıyırmalarda da patlıyordu (600 s'lik headless taramada
  738 statik temas, ortalama 0,14 m/s; kapıdan 5'i geçiyor).

## Kalite kapıları

```sh
npm run typecheck   # tsc, sıfır hata
npm run lint        # 0 hata (1 shadcn uyarısı bilinen)
npm test            # 74 birim + simülasyon testi, tarayıcı gerekmez
npm run build
npm run shot -- "http://127.0.0.1:8080/?autostart=1&hour=19" out.png   # headless ekran görüntüsü
```

Görsel değişikliklerde ekran görüntüsü alıp **bakmadan** "bitti" denmez.
Hata ayıklama URL'leri: `?autostart=1 &hour=19 &quality=low|high &seed=7 &stars=2 &nearcar=1 &debug=1`,
render kum havuzu: `/rendertest?hour=19`.

## Dil

Arayüz metinleri **Türkçe**; kod, yorum ve commit gövdesi teknik olarak açık olmalı (commit mesajları Türkçe yazılıyor).
