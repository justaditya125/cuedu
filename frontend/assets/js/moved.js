// "We have moved" page, served on the old domains (cuedu.in, cuedu.cutm.ac.in).
// Counts down, then sends the visitor to the same page on the new domain.
(function () {
  var NEW_ORIGIN = 'https://cutmonline.in';
  var SECONDS = 5;
  var target = NEW_ORIGIN + location.pathname + location.search + location.hash;
  var go = document.getElementById('go');
  var oldHost = document.getElementById('old-host');
  var secs = document.getElementById('secs');
  var count = document.getElementById('count');
  if (go) go.href = target;
  if (oldHost) oldHost.textContent = location.hostname.replace(/^www\./, '');
  var left = SECONDS;
  var timer = setInterval(function () {
    left -= 1;
    if (left <= 0) {
      clearInterval(timer);
      if (count) count.textContent = 'Redirecting…';
      location.replace(target);
    } else if (secs) {
      secs.textContent = String(left);
    }
  }, 1000);
})();
