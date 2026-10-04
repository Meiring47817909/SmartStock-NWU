// What each catalog product looks like, for scripts/generate-product-images.mjs.
//   subject  generic, unbranded description of the product (no logos or brand
//            names -- keeps the images clean and avoids look-alike trademarks)
//   angles   one camera angle per photo, in order; the first `images` entries
//            of the catalog item are used. Angle 1 is generated first and then
//            passed back to the model as a reference for the others, so every
//            angle shows the SAME unit.

export const PROMPTS = {
  'mechanical-keyboard': { subject: 'a full-size black mechanical keyboard with white backlit keycaps and a slim aluminium top plate',
    angles: ['top-down view', 'three-quarter angle view from the front left', 'low side profile view showing the key height'] },
  'wireless-mouse': { subject: 'a compact ergonomic matte-black wireless optical mouse with a scroll wheel',
    angles: ['top view', 'side view'] },
  'monitor-27': { subject: 'a modern 27-inch IPS computer monitor with very thin bezels, a silver height-adjustable stand, showing a calm landscape wallpaper on screen',
    angles: ['front view', 'three-quarter angle view', 'rear view showing the back panel and stand'] },
  'hd-webcam': { subject: 'a small black HD USB webcam with a round lens and a clip-on stand',
    angles: ['front view', 'side view showing the clip'] },
  'business-laptop': { subject: 'a slim 14-inch silver business laptop with a black keyboard and a plain desktop wallpaper on screen',
    angles: ['open, front view showing the screen and keyboard', 'closed, three-quarter top view', 'side view showing the ports'] },
  'desktop-pc': { subject: 'a compact black desktop PC tower case with a mesh front panel, a power button and two front USB ports',
    angles: ['front view', 'three-quarter angle view', 'rear view showing the ports and fan'] },
  'wifi-router': { subject: 'a white dual-band Wi-Fi router with three upright antennas and a row of small LED indicators on the front',
    angles: ['front view with antennas up', 'three-quarter angle view', 'rear view showing the Ethernet ports and power socket'] },
  'network-switch': { subject: 'a grey 24-port rack-mountable gigabit Ethernet network switch with small green link LEDs',
    angles: ['front view showing the ports', 'three-quarter angle view'] },
  'wireless-access-point': { subject: 'a round white ceiling-mount Wi-Fi access point with a subtle status LED ring',
    angles: ['view from slightly below, as if mounted on a ceiling', 'side view showing the thin profile and mounting plate'] },
  'ups-battery-backup': { subject: 'a black tower UPS battery backup unit with an LCD display and a row of power outlets',
    angles: ['front view', 'three-quarter angle view', 'rear view showing the outlets'] },
  'surge-power-strip': { subject: 'a white six-socket surge protector power strip with a lit on/off switch and a coiled power cord',
    angles: ['top view showing the sockets', 'three-quarter angle view with the cord'] },
  'external-hard-drive': { subject: 'a slim black portable 2TB external hard drive with a short USB cable beside it',
    angles: ['three-quarter angle view', 'top view'] },
  'ssd-1tb': { subject: 'a slim 2.5-inch SATA solid state drive in a plain dark grey metal case',
    angles: ['top view', 'side view'] },
  'usb-flash-drive': { subject: 'a small silver metal USB flash drive with a keyring loop, cap removed',
    angles: ['three-quarter angle view'] },
  'hdmi-cable': { subject: 'a black braided HDMI cable, loosely coiled, with both connectors visible',
    angles: ['three-quarter overhead view'] },
  'usb-c-cable': { subject: 'a white braided USB-C to USB-C charging cable, loosely coiled, with both connectors visible',
    angles: ['three-quarter overhead view'] },
  'displayport-cable': { subject: 'a black DisplayPort video cable, loosely coiled, with both connectors visible',
    angles: ['three-quarter overhead view'] },
  'ethernet-patch-cable': { subject: 'a blue Cat6 Ethernet patch cable, loosely coiled, with both RJ45 plugs visible',
    angles: ['three-quarter overhead view'] },
  'toner-cartridge': { subject: 'a black laser printer toner cartridge, plain unbranded dark casing with a handle',
    angles: ['three-quarter angle view'] },
  'a4-copy-paper': { subject: 'a sealed ream of white A4 copy paper in plain white wrapping, 500 sheets',
    angles: ['three-quarter angle view'] },
}
