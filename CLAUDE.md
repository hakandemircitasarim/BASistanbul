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
  ölçülür**: {doğuş, 20 m kuzey (x=1036 z=615), 40 m kuzey (z=595)} × {**7**, 12, 19, 21},
  `?autostart=1&hour=H&quality=high&noadapt=1`, 1280×720. Tur 8 yalnız doğuş karesini ölçtü ve kuzeye yürüyen kare
  747,5 bin ile tavanın üstündeydi. Tur 12 üç saat örnekledi ve **SABAHI KAÇIRDI**: 07:00 sıradan bir oyun saati ve
  19:00'dan 12,4 bin üçgen daha pahalı (alçak güneş + gölge kutusunun içindeki her şey aydınlık), yani sweep'e
  eklendi. Tur 13'ün KAPANIŞINDA on iki karenin hepsi yeniden ölçüldü (`scratchpad/pw/dv-worst.mjs <base>`, saat
  sabit, nüfus doyana kadar bekleme: **on iki satırın on ikisi de 40 yaya / 26-28 trafik**), doğuş – 20 m – 40 m,
  üçgen / çizim:
  **07:00 624.646/106 – 658.351/109 – 665.212/113**; öğlen 595.302/102 – 612.935/105 – 623.156/109;
  19:00 619.284/105 – 642.469/108 – 659.482/112; 21:00 575.080/100 – 580.697/102 – 594.198/106.
  **En kötü 665.212 üçgen / 113 çizim (07:00, 40 m kuzey) — en çok çizim de aynı karede, 113.**
  Uzun bekleyişli tek kare denetimi (`dv-one.mjs`, yalnız doyduktan sonra ölçer) aynı iki noktada 652.656/113 ve
  655.219/109 okuyor: tepe değer aynı kareyi gösteriyor.
  **Bağlayıcı KONUM artık 40 m kuzeydir, 20 m değil — dört saatin dördünde de.** Tur 13 doğuş yönünü (`CityProps.ts`
  `playerSpawn`) PI/2'den PI/4'e çevirdi; `dv-worst.mjs` oyuncuyu ışınlar ama yön vermez, yani **her satır bu yönü
  miras alır** ve yön değişikliği on iki karenin de neye baktığını değiştirdi. Yönü değiştiren tur tabloyu yeniden
  ölçmek zorundadır; eski satırın "bağlayıcı konum 20 m'dir" cümlesi PI/2 yönüne aitti.
  Şafağın tepesi yine 07:00'dir: 19:00 en kötü noktada 5,7 bin, öğlen 42,1 bin daha ucuz.
  Tabloyu 1280×720 dışında bir görüntü alanıyla ÖLÇME: bir tur-11 eleştirmeni aynı kareyi 640×360'ta 707.466 okudu
  ve tavana kalan payı 3,9 bin fazla gösterdi; LOD/paketleme kararları kare yüksekliğine bağlı.
  **Tavana kalan pay 54.788 üçgen ve 7 çizim.** Tur 13 kalabalığa gerçek bir LOD kademesi koyarak 718,4 binden
  665,2 bine indi — yani "yeni kalıcı bir mesh pratikte YOKTUR" cümlesi ARTIK GEÇERLİ DEĞİL, emekli edildi; ama
  **çizim payı üçgen payından dardır** (7 çizim), o yüzden yeni bir kalıcı *mesh* (yani yeni bir çizim çağrısı)
  hâlâ üçgenden daha pahalı bir karardır. Tur 10'da orta kademe araç gövdesi (`veh:mid:*`) yeniden gölge döküyor:
  ölçülen bedeli +11,5 bin üçgen ve +4 çizim (bandda bir düzine araçla; en kötü +5, anahtar başına bir çizim).
  Yeni kalıcı mesh eklemeden önce bunu hesaba kat.
  **Saati ölçüm boyunca sabitle**: güneş `sunDir.y > -0.06` eşiğini ~19.05'te geçiyor ve geçtiği anda tüm gölge geçişi
  düşüyor (aynı nokta 742 bin yerine 457 bin okuyor), yani sabitlenmemiş ölçümler karşılaştırılamaz.
  Nüfus da ölçümü kaydırır: kalabalık ve trafik yavaş doluyor; doymamış bir kare aynı noktada on binlerce üçgen
  düşük okur. **Görsel bir tur kapanmadan önce on iki kareyi de yeniden ölçüp bu satırı güncelle.**
  Kalabalık artık karenin en büyük kalemi DEĞİL. En kötü karede canlı sayım (07:00, 40 m kuzey, doymuş):
  **11 yakın × 1.990 × 2 geçiş + 16 uzak × 432 × 1 geçiş = 50.692 üçgen, karenin yüzde 7,8'i** (tur 12'nin yazdığı
  "40 × 1.926 × 2 = 154,1 bin, yüzde 22" iki kez yanlıştı: 40 yayanın hepsi menzilde değil, ve artık iki kademe var).
  `PED_RENDER.lodDist` 40 m (1,5 m histerezis): içeride altı parçalı yakın figür (1.990 üçgen, gölge döker),
  dışarıda tek birleşik `ped:far` (432 üçgen, gölge DÖKMEZ — ölçülen bedeli 1280×720 karenin ~100 pikseli, bkz.
  `PedRenderer` içindeki `far.castShadow` yorumu). `PED_RENDER.cullDist` 96 m'dir, son `cullFade` 6 m'de yaya
  `cullFloor` (0,55) boyuna iner ve menzil dışındaki yaya listeden tamamen ÇIKAR.
  Kalabalık hâlâ hiç frustum culling görmüyor (bütün yaya mesh'leri `frustumCulled = false`), yani kameranın
  arkasındaki yayalar da üçgen gönderiyor: sıradaki ucuz kalem bu.
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
- Temas lekesinin şekli ve solması örnek başına `instanceColor` üzerinde taşınır ve parça (fragment) tarafında
  **`USE_COLOR`** ile korunur. three r185 `USE_INSTANCING_COLOR`'ı YALNIZ vertex ön ekine yazar; parça ön eki aynı
  durumu `USE_COLOR` diye bildirir (`color_pars_fragment` de `vColor`'ı onun altında tanımlar). Tur 12 parça yarısını
  vertex-only tanıma bağlamıştı: her figürün lekesi sessizce yuvarlak DİKDÖRTGEN'e düşüyor ve kesme/doğuş solması hiç
  uygulanmıyordu. CPU tarafı testler bunu göremez — `render.test.ts` yamalı parça kaynağını okuyup tanımı doğruluyor.
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
  şekilde ~55 m içinde tek BatchedMesh'te tutar; aynı paket sokağa bakmayan cephelerin asgari donatısını da taşır
  (silme kuşağı `wallKit` 60 m, derz çıtası `joint` 42 m). **Hiçbir cephe boş DEĞİL**: `facade()` pencereli döşemeyi
  binanın her yüzüne sarar, yani boyalı kat çizgileri (dünya y'si `m.rowH`'un katı) ve aks çizgileri (yüzün başlangıç
  köşesinden `m.bayW`'nin katları) donatının arkasında durur. Bu ızgaraya oturmayan her donatı camı kesiyor: tur
  12'nin FLOOR_H'a (3,5 m) oturttuğu silme bir kulenin bütün pencere sırasının alt üçte birini kesiyordu (rowH hiçbir
  zaman 3,5 değil: 2,94 / 3,43 / 3,92 / 6,86), yuvarlak 9 m'deki derzler de camdan geçiyordu. Süpürgelik yok: döşemenin
  zemin sırası (büyük dükkân camları) duvar dibinin 0,02 sıra üstünde başlıyor, yani güvenli bir yüksekliği yok. `WEBGL_multi_draw` gerekir.
- Doku üretimi ana iş parçacığını bloke eder ve ilk kareden önce ödenir. **Tur 13 bu kalemi ölçülebilir biçimde
  pahalılaştırdı ve tur içinde "gürültü" diye kaydedildi; gerçek rakam şu** (aynı makinede, aynı harness
  `scratchpad/pw/rev-texgen.mjs`, aynı sunucu, 3 koşunun medyanı, sıfır argümanlı üreticilerin toplamı):
  681b6e1'de **~1,07 s** (yol 254 ms), tur 13 kapanışında **~1,17 s** (yol **367 ms**). Yani toplam +%9, yalnız
  `road()` +%44 — sebebi `chipClass`'ın iki sınıflı çakıl yatağı (~17,5 bin ince taş + ~4,1 bin iri taş, her biri üç
  kez çizilir). Kapanışta eklenen `CHIP.lift` (üç asfalt karosuna birer `scaleLinear` LUT geçişi) ölçülebilir bir şey
  eklemiyor: aynı ağaç lift'siz 1,15 s / yol 367 ms okudu. Makine yükü bu sayıyı kolayca ikiye katlar (bir tur-13
  denetçisi meşgul makinede 1,19-1,23 s'e karşı 1,36-1,69 s okudu), bu yüzden **her zaman iki ağacı arka arkaya ölç**.
  Gezinmeden ilk kareye ~7,0 s.
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
npm test            # 75 birim + simülasyon testi, tarayıcı gerekmez
npm run build
npm run shot -- "http://127.0.0.1:8080/?autostart=1&hour=19" out.png   # headless ekran görüntüsü
```

Görsel değişikliklerde ekran görüntüsü alıp **bakmadan** "bitti" denmez.
Hata ayıklama URL'leri: `?autostart=1 &hour=19 &quality=low|high &seed=7 &stars=2 &nearcar=1 &debug=1 &ao=0|1|2`,
render kum havuzu: `/rendertest?hour=19&view=plaza|beach|spawn|neon|fx&cam=x,y,z&look=x,y,z&ao=0`.

## Ölçüm disiplini (bu kurallar pahalıya öğrenildi — atlama)

- **Bir render iddiasını ÖNCE ölç.** Tur 11, 12 ve 13'te üç ayrı "regresyon" yanlış çıktı ve üçü de aynı iki
  sebepten geldi: çalışma zamanı düğmesiyle (runtime toggle) yapılan A/B, ve etkinin görünmediği bir kadraj.
  A/B **kaynak düzenlemesi + tam sayfa yeniden yüklemesiyle** yapılır.
- **Paralel ajanlar A/B'yi ÖZEL bir ağaç kopyasında yapar** (`git archive HEAD | tar -x` ile kendi dizinine, kendi
  portunda kendi vite'ı). Tur 13'te ortak ağaçta ölçen iki ajan birbirinin `scene.environment = null` /
  `castShadow = false` düzenlemelerini buldu, birini "geri aldı" ve bir yanlış sonuç üretti.
- **`&ao=0` olmadan `/rendertest`'te ölçme.** Kum havuzu GTAO'yu varsayılan olarak AÇIK başlatır, oyun ise kapalı
  koşar (`GameStore` `ao: false`) — yani `&ao=0`'sız her kum havuzu A/B'si sevk edilenden başka bir boru hattını
  ölçer. (`?ao=1` artık gerçekten renderer'a ulaşıyor; tur 13'e kadar `Engine.init` `this.renderer`'ı atamadan önce
  `applySettings` çağırdığı için sessizce hiçbir şey yapmıyordu. **Varsayılanı açma**: öğlen +590.676 üçgen / +75 çizim.)
- **Üç harness tuzağı**, her biri bir ajana birer saate mal oldu:
  1. Oyun tuvalinde `preserveDrawingBuffer` YOK: sayfa içinde `drawImage` ile piksel okumak siyah döndürür.
     Ekran görüntüsü al, sonra PNG'yi ölç.
  2. `loop.timeScale = 0` ile simülasyonu dondurup SONRA `world.time.hour`'u sabitlemek güneş VEKTÖRÜNÜ eski saatte
     bırakır (`DayNightSystem.refresh` artık koşmaz), gökyüzü ise yeni saate gider. Saati önce sabitle, güneşin
     oturması için bekle, sonra dondur.
  3. Headless sayfa 1 fps'in ALTINDA çiziyor: bir `page.evaluate` son yazından beri bir kare çizildiğini garanti
     etmez. Sahneye bir şey yerleştirdikten sonra okumadan önce ~1,5 s bekle.

## Dil

Arayüz metinleri **Türkçe**; kod, yorum ve commit gövdesi teknik olarak açık olmalı (commit mesajları Türkçe yazılıyor).
