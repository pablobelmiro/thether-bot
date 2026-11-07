// tether-bot website: copy buttons and the manual's "you are here" marker.
// Everything works without this file; it only adds conveniences.
(function () {
  'use strict'

  // Copy buttons: <button class="copy-btn" data-copy="#id" data-done="Copied">
  document.querySelectorAll('.copy-btn').forEach(function (btn) {
    btn.hidden = false
    btn.addEventListener('click', function () {
      var target = document.querySelector(btn.getAttribute('data-copy'))
      if (!target || !navigator.clipboard) return
      var text = target.innerText.replace(/^\$ /gm, '').trim()
      var label = btn.textContent
      navigator.clipboard.writeText(text).then(function () {
        btn.textContent = btn.getAttribute('data-done') || 'OK'
        setTimeout(function () { btn.textContent = label }, 1600)
      })
    })
  })

  // Manual: highlight the section currently in view in the table of contents.
  var toc = document.querySelector('.toc')
  if (!toc) return
  // On narrow screens the contents sit above the text: start collapsed.
  var tocDetails = toc.querySelector('details')
  var narrow = window.matchMedia('(max-width: 56rem)')
  if (tocDetails) {
    if (narrow.matches) tocDetails.open = false
    // On wide screens the summary can't be clicked, so keep the list open.
    var onChange = function () { if (!narrow.matches) tocDetails.open = true }
    if (narrow.addEventListener) narrow.addEventListener('change', onChange)
  }
  if (!('IntersectionObserver' in window)) return
  var links = {}
  toc.querySelectorAll('a[href^="#"]').forEach(function (a) {
    links[a.getAttribute('href').slice(1)] = a
  })
  var current = null
  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return
      var a = links[e.target.id]
      if (!a || a === current) return
      if (current) current.removeAttribute('aria-current')
      a.setAttribute('aria-current', 'true')
      current = a
    })
  }, { rootMargin: '-15% 0px -75% 0px' })
  Object.keys(links).forEach(function (id) {
    var el = document.getElementById(id)
    if (el) observer.observe(el)
  })
})()
