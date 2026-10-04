// The 20-product "real" demo catalog: one entry per product, with the number
// of photos it should have (1, 2 or 3) and the Pixabay search phrases used to
// find them. Used by scripts/fetch-product-images.mjs (downloads the photos +
// contact sheet into scripts/catalog-images/, which seed:comprehensive and
// seed:demo upload as the product photos).
//
// Names are deliberately generic (no brand/model): the photos come from a
// stock-photo library, so a specific model name would never match the picture.
//
// Per product:
//   slug        folder name under scripts/catalog-images/
//   images      how many photos (1, 2 or 3) -- 6 x 3, 7 x 2, 7 x 1 overall
//   queries     Pixabay search phrases, tried in order until enough photos
//   must        a photo is only eligible if one of its tags matches one of
//               these words/phrases (whole words, so "strip" won't match
//               "landing strip")
//   needs       optional second gate: ALSO needs a tag matching one of these
//               (e.g. a "switch" photo must also be network-related)
//   reject      a photo is dropped if any tag matches one of these (e.g. a
//               "keyboard" search must not return typewriters)
//   fallbackMust optional looser words, used only if too few photos pass
//               `must` -- fills the gap with a close relative of the product
//   pixabayIds  optional: force these exact Pixabay photo ids (use after
//               looking at the contact sheet), in display order
//   exclude     optional: Pixabay photo ids to never pick for this product

export const CATEGORIES = [
  { name: 'Cables & Adapters', description: 'USB, HDMI, DisplayPort, network cables' },
  { name: 'Consumables', description: 'Toner, paper, labels, cleaning kits' },
  { name: 'Laptops & Computers', description: 'Portable and desktop computers' },
  { name: 'Networking', description: 'Switches, routers, access points' },
  { name: 'Peripherals', description: 'Keyboards, mice, monitors, webcams' },
  { name: 'Power', description: 'UPS units, power strips, surge protectors' },
  { name: 'Storage', description: 'SSDs, HDDs, USB drives' },
]

export const CATALOG = [
  // ---- Peripherals ---------------------------------------------------------
  { slug: 'mechanical-keyboard', name: 'Mechanical Keyboard', category: 'Peripherals', barcode: 'CAT-KEYBOARD-01', images: 3, quantity: 14, reorder: 3,
    queries: ['mechanical keyboard isolated', 'mechanical keyboard', 'gaming keyboard', 'computer keyboard'],
    must: ['mechanical keyboard', 'gaming keyboard', 'keyboard'],
    reject: ['typewriter', 'vintage', 'retro', 'antique', 'laptop', 'macbook', 'notebook', 'smartphone', 'tablet', 'piano', 'synthesizer', 'musical'] },
  { slug: 'wireless-mouse', name: 'Wireless Mouse', category: 'Peripherals', barcode: 'CAT-MOUSE-01', images: 2, quantity: 22, reorder: 5,
    queries: ['wireless mouse isolated', 'computer mouse isolated', 'wireless mouse', 'computer mouse'],
    must: ['wireless mouse', 'computer mouse', 'mouse'],
    reject: ['animal', 'rodent', 'rat', 'hamster', 'mickey', 'laptop', 'macbook', 'keyboard'] },
  { slug: 'monitor-27', name: '27-inch Monitor', category: 'Peripherals', barcode: 'CAT-MONITOR-01', images: 3, quantity: 9, reorder: 2,
    queries: ['computer monitor isolated', 'monitor isolated', 'lcd monitor', 'computer monitor'],
    must: ['monitor', 'computer monitor', 'lcd monitor', 'flat screen', 'lcd screen'],
    reject: ['laptop', 'macbook', 'notebook', 'keyboard', 'printer', 'chart', 'seo', 'presentation', 'tablet', 'phone', 'iphone', 'smartphone', 'home office', 'workspace', 'desk', 'office', 'heart', 'ecg', 'television', 'tv', 'game', 'gaming', 'computer game', 'strategy', 'programming', 'code', 'coding', 'imac', 'player', 'broken', 'damage', 'damaged', 'trash', 'outdated', 'old', 'glass'] },
  { slug: 'hd-webcam', name: 'HD Webcam', category: 'Peripherals', barcode: 'CAT-WEBCAM-01', images: 2, quantity: 12, reorder: 3,
    queries: ['webcam isolated', 'webcam', 'web cam', 'web camera'],
    must: ['webcam', 'web cam', 'web camera'],
    reject: ['woman', 'man', 'girl', 'boy', 'security camera', 'cctv', 'surveillance', 'ski', 'mountain', 'mountains', 'winter', 'snow', 'nature', 'landscape', 'alps', 'gopro', 'action camera', 'webcam view'] },

  // ---- Laptops & Computers -------------------------------------------------
  { slug: 'business-laptop', name: 'Business Laptop', category: 'Laptops & Computers', barcode: 'CAT-LAPTOP-01', images: 3, quantity: 8, reorder: 2,
    queries: ['laptop isolated', 'laptop computer isolated', 'laptop computer', 'laptop'],
    must: ['laptop', 'laptop computer', 'notebook computer'],
    reject: ['keyboard', 'keys', 'dog', 'pet', 'animal', 'cat', 'phone', 'iphone', 'smartphone', 'tablet', 'pen', 'notepad', 'diary', 'coffee', 'cocktail', 'food', 'drink', 'flowers', 'plant', 'child', 'baby', 'book', 'chart', 'seo', 'graph', 'bed', 'beach', 'travel', 'cup', 'mug', 'glasses', 'couch', 'sofa', 'home office', 'floor', 'relaxed', 'remote work'] },
  { slug: 'desktop-pc', name: 'Desktop PC', category: 'Laptops & Computers', barcode: 'CAT-DESKTOP-01', images: 3, quantity: 6, reorder: 2,
    queries: ['desktop computer isolated', 'pc case isolated', 'computer tower', 'desktop computer', 'all in one pc'],
    must: ['desktop computer', 'desktop pc', 'pc case', 'computer case', 'computer tower', 'tower', 'imac', 'all-in-one', 'pc'],
    reject: ['laptop', 'macbook', 'notebook', 'tablet', 'phone', 'iphone', 'smartphone', 'cocktail', 'fruit', 'food', 'drink', 'coffee', 'cup', 'mug', 'glasses', 'plant', 'flowers', 'home office', 'workspace', 'cat', 'dog'] },

  // ---- Networking ----------------------------------------------------------
  { slug: 'wifi-router', name: 'Wi-Fi Router', category: 'Networking', barcode: 'CAT-ROUTER-01', images: 3, quantity: 10, reorder: 3,
    queries: ['wifi router isolated', 'router isolated', 'wifi router', 'wireless router'],
    must: ['wifi router', 'wireless router', 'router', 'modem'],
    reject: ['phone', 'smartphone', 'mobile', 'hotspot', 'tablet', 'laptop', 'macbook', 'woodworking', 'wood', 'tool', 'cnc', 'milling', 'sound', 'microphone', '3d', '3d model', 'model', 'male', 'female', 'radio'] },
  { slug: 'network-switch', name: 'Network Switch', category: 'Networking', barcode: 'CAT-SWITCH-01', images: 2, quantity: 7, reorder: 2,
    queries: ['network switch isolated', 'network switch', 'ethernet switch', 'switch ethernet ports'],
    must: ['network switch', 'ethernet switch', 'switch'],
    needs: ['network', 'networking', 'ethernet', 'server', 'lan', 'rj45', 'router', 'patch panel', 'data center'],
    reject: ['light switch', 'toggle', 'nintendo', 'game', 'gaming', 'console', 'lamp', 'wall', 'electric', 'bulb', 'light'] },
  { slug: 'wireless-access-point', name: 'Wireless Access Point', category: 'Networking', barcode: 'CAT-AP-01', images: 2, quantity: 11, reorder: 3,
    queries: ['wireless access point', 'wifi access point', 'unifi access point'],
    must: ['access point', 'wifi access point', 'wireless access point', 'unifi', 'ubiquiti'],
    fallbackMust: ['wifi router', 'wireless router', 'router', 'wlan', 'modem'],
    reject: ['laptop', 'macbook', 'notebook', 'phone', 'iphone', 'smartphone', 'hotspot', 'tablet'] },

  // ---- Power ---------------------------------------------------------------
  { slug: 'ups-battery-backup', name: 'UPS Battery Backup 1500VA', category: 'Power', barcode: 'CAT-UPS-01', images: 3, quantity: 5, reorder: 2,
    queries: ['ups battery backup', 'uninterruptible power supply'],
    must: ['uninterruptible power supply', 'ups', 'battery backup'],
    reject: ['truck', 'van', 'delivery', 'package', 'parcel', 'shipping', 'courier', 'car', 'woman', 'man'] },
  { slug: 'surge-power-strip', name: 'Surge Protector Power Strip', category: 'Power', barcode: 'CAT-POWERSTRIP-01', images: 2, quantity: 25, reorder: 6,
    queries: ['power strip isolated', 'power strip', 'surge protector', 'multiple socket extension'],
    must: ['power strip', 'surge protector', 'multiple socket', 'multi socket', 'extension cord', 'extension lead', 'power outlet', 'socket strip', 'power socket', 'plug socket'],
    reject: ['airplane', 'aircraft', 'airport', 'aviation', 'landing strip', 'runway', 'comic', 'film', 'bar', 'hair', 'bikini', 'woman', 'wall plate'] },

  // ---- Storage -------------------------------------------------------------
  { slug: 'external-hard-drive', name: 'External Hard Drive 2TB', category: 'Storage', barcode: 'CAT-HDD-01', images: 2, quantity: 16, reorder: 4,
    queries: ['external hard drive isolated', 'external hard drive', 'hard disk drive isolated', 'hdd'],
    must: ['external hard drive', 'external hard disk', 'hard drive', 'hard disk', 'hdd', 'harddisk'],
    reject: ['laptop', 'macbook', 'woman', 'man', 'phone'] },
  { slug: 'ssd-1tb', name: 'Solid State Drive 1TB', category: 'Storage', barcode: 'CAT-SSD-01', images: 2, quantity: 18, reorder: 4,
    queries: ['ssd isolated', 'ssd solid state drive', 'ssd', 'nvme ssd'],
    must: ['ssd', 'solid state drive', 'nvme', 'm.2'],
    reject: ['laptop', 'macbook', 'woman', 'man', 'phone', 'sd card'] },
  { slug: 'usb-flash-drive', name: 'USB Flash Drive 64GB', category: 'Storage', barcode: 'CAT-USBDRIVE-01', images: 1, quantity: 40, reorder: 10,
    queries: ['usb flash drive isolated', 'usb flash drive', 'usb stick', 'pen drive'],
    must: ['usb flash drive', 'flash drive', 'usb stick', 'pen drive', 'memory stick', 'thumb drive'],
    reject: ['woman', 'man', 'laptop', 'macbook', 'phone'] },

  // ---- Cables & Adapters ---------------------------------------------------
  { slug: 'hdmi-cable', name: 'HDMI Cable 2m', category: 'Cables & Adapters', barcode: 'CAT-HDMI-01', images: 1, quantity: 35, reorder: 8,
    queries: ['hdmi cable isolated', 'hdmi cable', 'hdmi'],
    must: ['hdmi cable', 'hdmi'],
    reject: ['woman', 'man', 'television', 'tv', 'laptop', 'macbook', 'phone'] },
  { slug: 'usb-c-cable', name: 'USB-C Cable 1m', category: 'Cables & Adapters', barcode: 'CAT-USBC-01', images: 1, quantity: 45, reorder: 10,
    queries: ['usb c cable isolated', 'usb c cable', 'usb type c cable', 'type c cable'],
    must: ['usb c', 'usb-c', 'type c', 'type-c', 'usb type c'],
    fallbackMust: ['usb cable', 'charging cable', 'usb', 'cable'],
    reject: ['woman', 'man', 'laptop', 'macbook', 'phone', 'smartphone', 'iphone', 'wireless'] },
  { slug: 'displayport-cable', name: 'DisplayPort Cable 2m', category: 'Cables & Adapters', barcode: 'CAT-DP-01', images: 1, quantity: 20, reorder: 5,
    queries: ['displayport cable', 'display port cable'],
    must: ['displayport', 'display port'],
    reject: ['woman', 'man', 'microphone', 'studio', 'music', 'guitar', 'audio', 'laptop', 'macbook'] },
  { slug: 'ethernet-patch-cable', name: 'Ethernet Patch Cable Cat6', category: 'Cables & Adapters', barcode: 'CAT-ETHERNET-01', images: 1, quantity: 60, reorder: 15,
    queries: ['ethernet cable isolated', 'ethernet cable', 'network cable', 'rj45 cable'],
    must: ['ethernet cable', 'network cable', 'lan cable', 'rj45', 'patch cable', 'cat6', 'cat5', 'ethernet'],
    reject: ['fiber', 'fibre', 'optic', 'optical', 'glass', 'light', 'rope', 'twine', 'thread', 'woman', 'man', 'laptop'] },

  // ---- Consumables ---------------------------------------------------------
  { slug: 'toner-cartridge', name: 'Laser Toner Cartridge (Black)', category: 'Consumables', barcode: 'CAT-TONER-01', images: 1, quantity: 15, reorder: 4,
    queries: ['toner cartridge isolated', 'toner cartridge', 'printer toner', 'ink cartridge'],
    must: ['toner', 'toner cartridge', 'ink cartridge', 'printer cartridge', 'laser toner'],
    reject: ['woman', 'man', 'laptop', 'gun', 'ammunition', 'bullet', 'vape', 'e-cigarette', 'vinyl', 'vynil', 'turntable', 'pickup', 'record', 'gramophone', 'phonograph', 'stylus', 'tattoo', 'pen', 'synthesizer', 'oscillator', 'music', 'musician', 'sound', 'instruments', 'studio'],
    needs: ['printer', 'laser', 'ink', 'cartridge', 'printing', 'print', 'office'] },
  { slug: 'a4-copy-paper', name: 'A4 Copy Paper (500 sheets)', category: 'Consumables', barcode: 'CAT-PAPER-01', images: 1, quantity: 80, reorder: 20,
    queries: ['ream of paper isolated', 'ream of paper', 'printer paper', 'paper stack'],
    must: ['ream', 'ream of paper', 'paper stack', 'stack of paper', 'printer paper', 'copy paper', 'office paper', 'a4 paper', 'a4', 'sheets of paper', 'blank paper'],
    reject: ['woman', 'man', 'origami', 'craft', 'wallpaper', 'crumpled', 'texture', 'newspaper', 'toilet paper', 'book', 'handmade', 'specialty', 'parchment', 'vintage', 'old', 'rolled', 'roll', 'origami', 'boat', 'ship', 'globe', 'travel', 'nature', 'shredder', 'shredded', 'shredding', 'recycling', 'waste', 'garbage', 'disposal', 'strip', 'fire', 'burning'] },
]
