/* Shared map picker. Opened as an iframe by the admin panel and as a WebView by
 * the mobile app. Reads lat/lng/name/address from the URL, lets the user pick a
 * point (tap, drag the marker, search "my location"), reverse-geocodes the point
 * into the address field, and sends {lat,lng,address} back to whoever opened it.
 *
 * Leaflet and tiles come from our own origin / OpenStreetMap; no inline script
 * (the panel CSP forbids it), so everything lives in this file. */
(function () {
  var qs = new URLSearchParams(location.search);
  var num = function (v) { var n = Number(v); return Number.isFinite(n) ? n : null; };
  var lat = num(qs.get('lat'));
  var lng = num(qs.get('lng'));
  var hasPoint = lat != null && lng != null;
  // Default view: Uzbekistan (Fergana valley), where most suppliers are.
  var start = hasPoint ? [lat, lng] : [40.38, 71.78];

  // An explicit icon with vendored images, resolved relative to this page.
  // (L.Icon.Default would auto-detect and double the path prefix.)
  var icon = L.icon({
    iconUrl: 'vendor/leaflet/images/marker-icon.png',
    iconRetinaUrl: 'vendor/leaflet/images/marker-icon-2x.png',
    shadowUrl: 'vendor/leaflet/images/marker-shadow.png',
    iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41],
  });

  var map = L.map('map', { zoomControl: true }).setView(start, hasPoint ? 16 : 8);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap',
  }).addTo(map);

  var marker = L.marker(start, { draggable: true, icon: icon }).addTo(map);
  var addr = document.getElementById('addr');
  if (qs.get('address')) addr.value = qs.get('address');

  var geocodeTimer = null;
  // Fill the address from the point, unless the user has typed their own.
  function reverseGeocode(ll) {
    clearTimeout(geocodeTimer);
    geocodeTimer = setTimeout(function () {
      fetch('https://nominatim.openstreetmap.org/reverse?format=json&zoom=18&lat=' + ll.lat + '&lon=' + ll.lng, {
        headers: { 'Accept-Language': 'uz,ru,en' },
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (j && j.display_name && !addr.dataset.touched) addr.value = j.display_name;
      }).catch(function () { /* offline or rate-limited: keep manual address */ });
    }, 400);
  }

  function setPoint(ll, geocode) {
    marker.setLatLng(ll);
    if (geocode !== false) reverseGeocode(ll);
  }

  map.on('click', function (e) { setPoint(e.latlng); });
  marker.on('dragend', function () { setPoint(marker.getLatLng()); });
  addr.addEventListener('input', function () { addr.dataset.touched = '1'; });

  document.getElementById('here').onclick = function () {
    if (!navigator.geolocation) return;
    this.textContent = '…';
    var btn = this;
    navigator.geolocation.getCurrentPosition(function (p) {
      var ll = { lat: p.coords.latitude, lng: p.coords.longitude };
      map.setView(ll, 17);
      setPoint(ll);
      btn.textContent = '📍';
    }, function () { btn.textContent = '📍'; }, { enableHighAccuracy: true, timeout: 10000 });
  };

  function send(payload) {
    var msg = JSON.stringify(payload);
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(msg);
    else if (window.parent !== window) window.parent.postMessage({ yayaMap: payload }, location.origin);
  }
  document.getElementById('save').onclick = function () {
    var ll = marker.getLatLng();
    send({ ok: true, lat: Math.round(ll.lat * 1e6) / 1e6, lng: Math.round(ll.lng * 1e6) / 1e6, address: addr.value.trim() });
  };
  document.getElementById('cancel').onclick = function () { send({ ok: false }); };

  // The app can push the device's current location in after it gets permission.
  window.addEventListener('message', function (e) {
    try {
      var d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      if (d && d.setHere && Number.isFinite(d.lat) && Number.isFinite(d.lng)) { map.setView([d.lat, d.lng], 17); setPoint({ lat: d.lat, lng: d.lng }); }
    } catch (_) { /* ignore */ }
  });
})();
