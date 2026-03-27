/**
 * WFG3 CV Bridge
 *
 * Low-level image-processing primitives for browser-native WFG3.
 * Uses OpenCV.js (window.cv) when available; provides honest pure-JS
 * fallbacks when it is not.
 *
 * Every public function lives on window._WFG3_CV.
 */
(function (global) {
  'use strict';

  var _cv = function () { return global.cv || null; };

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                            */
  /* ------------------------------------------------------------------ */

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function idx(x, y, w) { return y * w + x; }

  /* ------------------------------------------------------------------ */
  /*  Resize (bilinear)                                                  */
  /* ------------------------------------------------------------------ */

  function resizeBilinear(src, srcW, srcH, dstW, dstH, channels) {
    var ch = channels || 1;
    var dst = new (src.constructor)(dstW * dstH * ch);
    var sx = srcW / dstW, sy = srcH / dstH;
    for (var dy = 0; dy < dstH; dy++) {
      var fy = (dy + 0.5) * sy - 0.5;
      var iy = fy | 0; if (iy < 0) iy = 0;
      var iy1 = iy + 1 < srcH ? iy + 1 : iy;
      var wy = fy - iy; if (wy < 0) wy = 0;
      for (var dx = 0; dx < dstW; dx++) {
        var fx = (dx + 0.5) * sx - 0.5;
        var ix = fx | 0; if (ix < 0) ix = 0;
        var ix1 = ix + 1 < srcW ? ix + 1 : ix;
        var wx = fx - ix; if (wx < 0) wx = 0;
        for (var c = 0; c < ch; c++) {
          var v00 = src[(iy * srcW + ix) * ch + c];
          var v10 = src[(iy * srcW + ix1) * ch + c];
          var v01 = src[(iy1 * srcW + ix) * ch + c];
          var v11 = src[(iy1 * srcW + ix1) * ch + c];
          dst[(dy * dstW + dx) * ch + c] =
            (v00 * (1 - wx) * (1 - wy) + v10 * wx * (1 - wy) +
             v01 * (1 - wx) * wy + v11 * wx * wy) | 0;
        }
      }
    }
    return dst;
  }

  /**
   * Resize a single-channel Uint8 image.
   */
  function resizeGray(src, srcW, srcH, dstW, dstH) {
    var cv = _cv();
    if (cv) {
      var mat = new cv.Mat(srcH, srcW, cv.CV_8UC1);
      mat.data.set(src);
      var dst = new cv.Mat();
      var interp = (dstW < srcW) ? cv.INTER_AREA : cv.INTER_CUBIC;
      cv.resize(mat, dst, new cv.Size(dstW, dstH), 0, 0, interp);
      var out = new Uint8Array(dst.data);
      mat.delete(); dst.delete();
      return out;
    }
    return resizeBilinear(src, srcW, srcH, dstW, dstH, 1);
  }

  /**
   * Resize 3-channel (packed RGB) Uint8 image.
   */
  function resizeRGB(r, g, b, srcW, srcH, dstW, dstH) {
    var n = srcW * srcH;
    var packed = new Uint8Array(n * 3);
    for (var i = 0; i < n; i++) { packed[i * 3] = r[i]; packed[i * 3 + 1] = g[i]; packed[i * 3 + 2] = b[i]; }
    var dst = resizeBilinear(packed, srcW, srcH, dstW, dstH, 3);
    var dn = dstW * dstH;
    var dr = new Uint8Array(dn), dg = new Uint8Array(dn), db = new Uint8Array(dn);
    for (var j = 0; j < dn; j++) { dr[j] = dst[j * 3]; dg[j] = dst[j * 3 + 1]; db[j] = dst[j * 3 + 2]; }
    return { r: dr, g: dg, b: db };
  }

  /* ------------------------------------------------------------------ */
  /*  Gaussian blur (separable)                                          */
  /* ------------------------------------------------------------------ */

  function makeGaussKernel(radius) {
    var size = 2 * radius + 1;
    var sigma = radius * 0.5 + 0.3;
    var k = new Float32Array(size), sum = 0;
    for (var i = 0; i < size; i++) {
      var x = i - radius;
      k[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
      sum += k[i];
    }
    for (var j = 0; j < size; j++) k[j] /= sum;
    return k;
  }

  /**
   * Apply separable Gaussian blur to single-channel Uint8 image.
   */
  function gaussianBlur(src, w, h, radius) {
    var cv = _cv();
    if (cv) {
      var ksize = 2 * radius + 1;
      var mat = new cv.Mat(h, w, cv.CV_8UC1);
      mat.data.set(src);
      var dst = new cv.Mat();
      cv.GaussianBlur(mat, dst, new cv.Size(ksize, ksize), 0);
      var out = new Uint8Array(dst.data);
      mat.delete(); dst.delete();
      return out;
    }
    var k = makeGaussKernel(radius);
    var ks = k.length;
    var r = (ks - 1) >> 1;
    var tmp = new Float32Array(w * h);
    var out = new Uint8Array(w * h);
    // horizontal pass
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var acc = 0;
        for (var ki = 0; ki < ks; ki++) {
          var sx = clamp(x + ki - r, 0, w - 1);
          acc += src[y * w + sx] * k[ki];
        }
        tmp[y * w + x] = acc;
      }
    }
    // vertical pass
    for (var y2 = 0; y2 < h; y2++) {
      for (var x2 = 0; x2 < w; x2++) {
        var acc2 = 0;
        for (var ki2 = 0; ki2 < ks; ki2++) {
          var sy = clamp(y2 + ki2 - r, 0, h - 1);
          acc2 += tmp[sy * w + x2] * k[ki2];
        }
        out[y2 * w + x2] = clamp(Math.round(acc2), 0, 255);
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /*  Bilateral filter (simplified)                                      */
  /* ------------------------------------------------------------------ */

  function bilateralFilter(src, w, h, radius, sigmaColor, sigmaSpace) {
    var cv = _cv();
    if (cv) {
      var mat = new cv.Mat(h, w, cv.CV_8UC1);
      mat.data.set(src);
      var dst = new cv.Mat();
      cv.bilateralFilter(mat, dst, 2 * radius + 1, sigmaColor, sigmaSpace);
      var out = new Uint8Array(dst.data);
      mat.delete(); dst.delete();
      return out;
    }
    var dst = new Uint8Array(w * h);
    var sc2 = -0.5 / (sigmaColor * sigmaColor);
    var ss2 = -0.5 / (sigmaSpace * sigmaSpace);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var cval = src[y * w + x];
        var wsum = 0, vsum = 0;
        for (var dy = -radius; dy <= radius; dy++) {
          var ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (var dx = -radius; dx <= radius; dx++) {
            var nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            var nval = src[ny * w + nx];
            var dspace = dx * dx + dy * dy;
            var dcolor = (nval - cval); dcolor *= dcolor;
            var weight = Math.exp(dspace * ss2 + dcolor * sc2);
            wsum += weight;
            vsum += nval * weight;
          }
        }
        dst[y * w + x] = clamp(Math.round(vsum / wsum), 0, 255);
      }
    }
    return dst;
  }

  /* ------------------------------------------------------------------ */
  /*  RGB <-> LAB conversion (D65 illuminant, sRGB)                      */
  /* ------------------------------------------------------------------ */

  function srgbToLinear(v) {
    var s = v / 255.0;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }

  function labF(t) {
    return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16.0 / 116.0;
  }

  /**
   * Convert separate R, G, B Uint8 arrays to packed Float32 LAB (3 channels per pixel).
   * Returns { L: Float32Array, a: Float32Array, b: Float32Array }.
   */
  function rgbToLAB(rArr, gArr, bArr, n) {
    var cv = _cv();
    if (cv) {
      var mat = new cv.Mat(1, n, cv.CV_8UC3);
      var d = mat.data;
      for (var ci = 0; ci < n; ci++) {
        d[ci * 3] = rArr[ci];
        d[ci * 3 + 1] = gArr[ci];
        d[ci * 3 + 2] = bArr[ci];
      }
      var lab = new cv.Mat();
      cv.cvtColor(mat, lab, cv.COLOR_RGB2Lab);
      var L = new Float32Array(n), a = new Float32Array(n), b = new Float32Array(n);
      for (var li = 0; li < n; li++) {
        L[li] = lab.data[li * 3] * (100 / 255);      // OpenCV L is 0-255, scale to 0-100
        a[li] = lab.data[li * 3 + 1] - 128;           // OpenCV a/b are 0-255, center at 0
        b[li] = lab.data[li * 3 + 2] - 128;
      }
      mat.delete(); lab.delete();
      return { L: L, a: a, b: b };
    }

    var L = new Float32Array(n), aOut = new Float32Array(n), bOut = new Float32Array(n);
    // D65 reference white
    var Xn = 0.95047, Yn = 1.00000, Zn = 1.08883;
    for (var i = 0; i < n; i++) {
      var rl = srgbToLinear(rArr[i]);
      var gl = srgbToLinear(gArr[i]);
      var bl = srgbToLinear(bArr[i]);
      var X = 0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl;
      var Y = 0.2126729 * rl + 0.7151522 * gl + 0.0721750 * bl;
      var Z = 0.0193339 * rl + 0.1191920 * gl + 0.9503041 * bl;
      var fx = labF(X / Xn), fy = labF(Y / Yn), fz = labF(Z / Zn);
      L[i] = 116.0 * fy - 16.0;
      aOut[i] = 500.0 * (fx - fy);
      bOut[i] = 200.0 * (fy - fz);
    }
    return { L: L, a: aOut, b: bOut };
  }

  /* ------------------------------------------------------------------ */
  /*  Sobel gradients                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Sobel gradient for single-channel Uint8 image.
   * Returns { gx: Float32Array, gy: Float32Array, mag: Float32Array }.
   */
  function sobelGradients(src, w, h) {
    var cv = _cv();
    if (cv) {
      var mat = new cv.Mat(h, w, cv.CV_8UC1);
      mat.data.set(src);
      var gxMat = new cv.Mat(), gyMat = new cv.Mat(), magMat = new cv.Mat();
      cv.Sobel(mat, gxMat, cv.CV_32F, 1, 0, 3);
      cv.Sobel(mat, gyMat, cv.CV_32F, 0, 1, 3);
      cv.magnitude(gxMat, gyMat, magMat);
      var gx = new Float32Array(gxMat.data32F);
      var gy = new Float32Array(gyMat.data32F);
      var mag = new Float32Array(magMat.data32F);
      mat.delete(); gxMat.delete(); gyMat.delete(); magMat.delete();
      return { gx: gx, gy: gy, mag: mag };
    }

    var gx = new Float32Array(w * h);
    var gy = new Float32Array(w * h);
    var mag = new Float32Array(w * h);
    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var i = y * w + x;
        var v00 = src[(y - 1) * w + (x - 1)], v10 = src[(y - 1) * w + x], v20 = src[(y - 1) * w + (x + 1)];
        var v01 = src[y * w + (x - 1)],                                     v21 = src[y * w + (x + 1)];
        var v02 = src[(y + 1) * w + (x - 1)], v12 = src[(y + 1) * w + x], v22 = src[(y + 1) * w + (x + 1)];
        var dx = -v00 + v20 - 2 * v01 + 2 * v21 - v02 + v22;
        var dy = -v00 - 2 * v10 - v20 + v02 + 2 * v12 + v22;
        gx[i] = dx;
        gy[i] = dy;
        mag[i] = Math.sqrt(dx * dx + dy * dy);
      }
    }
    return { gx: gx, gy: gy, mag: mag };
  }

  /* ------------------------------------------------------------------ */
  /*  Canny edge detection                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Canny edge detector.  Returns Uint8Array (0 or 255).
   */
  function cannyEdge(gray, w, h, lo, hi) {
    var cv = _cv();
    if (cv) {
      var mat = new cv.Mat(h, w, cv.CV_8UC1);
      mat.data.set(gray);
      var dst = new cv.Mat();
      cv.Canny(mat, dst, lo, hi, 3, true);
      var out = new Uint8Array(dst.data);
      mat.delete(); dst.delete();
      return out;
    }

    // Pure-JS Canny: Sobel → NMS → double threshold → hysteresis
    var grad = sobelGradients(gray, w, h);
    var nms = new Float32Array(w * h);

    // non-maximum suppression
    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var i = y * w + x;
        var m = grad.mag[i];
        if (m < 1) continue;
        var angle = Math.atan2(grad.gy[i], grad.gx[i]);
        if (angle < 0) angle += Math.PI;
        var n1, n2;
        if (angle < Math.PI / 8 || angle >= 7 * Math.PI / 8) {
          n1 = grad.mag[i - 1]; n2 = grad.mag[i + 1];
        } else if (angle < 3 * Math.PI / 8) {
          n1 = grad.mag[(y - 1) * w + (x + 1)]; n2 = grad.mag[(y + 1) * w + (x - 1)];
        } else if (angle < 5 * Math.PI / 8) {
          n1 = grad.mag[(y - 1) * w + x]; n2 = grad.mag[(y + 1) * w + x];
        } else {
          n1 = grad.mag[(y - 1) * w + (x - 1)]; n2 = grad.mag[(y + 1) * w + (x + 1)];
        }
        nms[i] = (m >= n1 && m >= n2) ? m : 0;
      }
    }

    // normalize magnitude for threshold comparison
    var maxMag = 0;
    for (var k = 0; k < nms.length; k++) if (nms[k] > maxMag) maxMag = nms[k];
    if (maxMag < 1) maxMag = 1;
    var scale = 255 / maxMag;

    var edge = new Uint8Array(w * h);
    // strong / weak classification
    for (var j = 0; j < nms.length; j++) {
      var v = nms[j] * scale;
      if (v >= hi) edge[j] = 255;
      else if (v >= lo) edge[j] = 128;
    }

    // hysteresis: promote weak pixels connected to strong
    var changed = true;
    while (changed) {
      changed = false;
      for (var y2 = 1; y2 < h - 1; y2++) {
        for (var x2 = 1; x2 < w - 1; x2++) {
          var p = y2 * w + x2;
          if (edge[p] !== 128) continue;
          for (var dy = -1; dy <= 1; dy++) {
            for (var dx = -1; dx <= 1; dx++) {
              if (edge[(y2 + dy) * w + (x2 + dx)] === 255) {
                edge[p] = 255;
                changed = true;
                break;
              }
            }
            if (edge[p] === 255) break;
          }
        }
      }
    }

    // suppress weak
    for (var m2 = 0; m2 < edge.length; m2++) if (edge[m2] !== 255) edge[m2] = 0;
    return edge;
  }

  /* ------------------------------------------------------------------ */
  /*  Morphological operations                                           */
  /* ------------------------------------------------------------------ */

  function dilate(src, w, h, radius) {
    var cv = _cv();
    if (cv) {
      var mat = new cv.Mat(h, w, cv.CV_8UC1);
      mat.data.set(src);
      var dst = new cv.Mat();
      var kern = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2 * radius + 1, 2 * radius + 1));
      cv.dilate(mat, dst, kern);
      var out = new Uint8Array(dst.data);
      mat.delete(); dst.delete(); kern.delete();
      return out;
    }
    var dst = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var mx = 0;
        for (var dy = -radius; dy <= radius; dy++) {
          var ny = y + dy; if (ny < 0 || ny >= h) continue;
          for (var dx = -radius; dx <= radius; dx++) {
            var nx = x + dx; if (nx < 0 || nx >= w) continue;
            if (dx * dx + dy * dy > radius * radius + 1) continue;
            var v = src[ny * w + nx];
            if (v > mx) mx = v;
          }
        }
        dst[y * w + x] = mx;
      }
    }
    return dst;
  }

  function erode(src, w, h, radius) {
    var cv = _cv();
    if (cv) {
      var mat = new cv.Mat(h, w, cv.CV_8UC1);
      mat.data.set(src);
      var dst = new cv.Mat();
      var kern = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2 * radius + 1, 2 * radius + 1));
      cv.erode(mat, dst, kern);
      var out = new Uint8Array(dst.data);
      mat.delete(); dst.delete(); kern.delete();
      return out;
    }
    var dst = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var mn = 255;
        for (var dy = -radius; dy <= radius; dy++) {
          var ny = y + dy; if (ny < 0 || ny >= h) continue;
          for (var dx = -radius; dx <= radius; dx++) {
            var nx = x + dx; if (nx < 0 || nx >= w) continue;
            if (dx * dx + dy * dy > radius * radius + 1) continue;
            var v = src[ny * w + nx];
            if (v < mn) mn = v;
          }
        }
        dst[y * w + x] = mn;
      }
    }
    return dst;
  }

  function morphClose(src, w, h, radius) {
    return erode(dilate(src, w, h, radius), w, h, radius);
  }

  function morphOpen(src, w, h, radius) {
    return dilate(erode(src, w, h, radius), w, h, radius);
  }

  /* ------------------------------------------------------------------ */
  /*  LAB neighbor delta                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Per-pixel max LAB delta to right/below neighbor.
   * Input: L, a, b Float32Arrays.  Output: Float32Array (deltaE).
   */
  function labNeighborDelta(L, a, b, w, h) {
    var n = w * h;
    var delta = new Float32Array(n);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = y * w + x;
        var dMax = 0;
        // right neighbor
        if (x + 1 < w) {
          var j = i + 1;
          var dL = L[j] - L[i], da = a[j] - a[i], db = b[j] - b[i];
          var d = Math.sqrt(dL * dL + da * da + db * db);
          if (d > dMax) dMax = d;
        }
        // below neighbor
        if (y + 1 < h) {
          var j2 = i + w;
          var dL2 = L[j2] - L[i], da2 = a[j2] - a[i], db2 = b[j2] - b[i];
          var d2 = Math.sqrt(dL2 * dL2 + da2 * da2 + db2 * db2);
          if (d2 > dMax) dMax = d2;
        }
        delta[i] = dMax;
      }
    }
    return delta;
  }

  /* ------------------------------------------------------------------ */
  /*  Distance transform                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Euclidean distance transform (BFS-based approximation).
   * Input: Uint8Array where >0 = foreground.
   * Output: Float32Array with distance to nearest zero-pixel.
   */
  function distanceTransform(mask, w, h) {
    var cv = _cv();
    if (cv) {
      var mat = new cv.Mat(h, w, cv.CV_8UC1);
      mat.data.set(mask);
      var dst = new cv.Mat();
      cv.distanceTransform(mat, dst, cv.DIST_L2, 5);
      var out = new Float32Array(dst.data32F);
      mat.delete(); dst.delete();
      return out;
    }
    var INF = w + h;
    var dist = new Float32Array(w * h);
    // Pass 1: forward
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = y * w + x;
        if (mask[i] === 0) { dist[i] = 0; continue; }
        dist[i] = INF;
        if (y > 0) dist[i] = Math.min(dist[i], dist[(y - 1) * w + x] + 1);
        if (x > 0) dist[i] = Math.min(dist[i], dist[y * w + (x - 1)] + 1);
        if (y > 0 && x > 0) dist[i] = Math.min(dist[i], dist[(y - 1) * w + (x - 1)] + 1.414);
        if (y > 0 && x + 1 < w) dist[i] = Math.min(dist[i], dist[(y - 1) * w + (x + 1)] + 1.414);
      }
    }
    // Pass 2: backward
    for (var y2 = h - 1; y2 >= 0; y2--) {
      for (var x2 = w - 1; x2 >= 0; x2--) {
        var i2 = y2 * w + x2;
        if (y2 + 1 < h) dist[i2] = Math.min(dist[i2], dist[(y2 + 1) * w + x2] + 1);
        if (x2 + 1 < w) dist[i2] = Math.min(dist[i2], dist[y2 * w + (x2 + 1)] + 1);
        if (y2 + 1 < h && x2 + 1 < w) dist[i2] = Math.min(dist[i2], dist[(y2 + 1) * w + (x2 + 1)] + 1.414);
        if (y2 + 1 < h && x2 > 0) dist[i2] = Math.min(dist[i2], dist[(y2 + 1) * w + (x2 - 1)] + 1.414);
      }
    }
    return dist;
  }

  /* ------------------------------------------------------------------ */
  /*  Connected components (Union-Find)                                  */
  /* ------------------------------------------------------------------ */

  /**
   * 8-connected component labeling.
   * Input: Uint8Array where >0 = foreground.
   * Returns { labels: Int32Array, count: number, stats: Object }.
   */
  function connectedComponents(mask, w, h) {
    var n = w * h;
    var labels = new Int32Array(n);
    var parent = [];
    var nextLabel = 1;

    function find(x) {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    }
    function union(a, b) {
      a = find(a); b = find(b);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }

    parent.push(0); // label 0 = background

    // First pass
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = y * w + x;
        if (mask[i] === 0) continue;
        var neighbors = [];
        if (x > 0 && labels[i - 1] > 0) neighbors.push(labels[i - 1]);
        if (y > 0 && labels[i - w] > 0) neighbors.push(labels[i - w]);
        if (y > 0 && x > 0 && labels[(y - 1) * w + (x - 1)] > 0) neighbors.push(labels[(y - 1) * w + (x - 1)]);
        if (y > 0 && x + 1 < w && labels[(y - 1) * w + (x + 1)] > 0) neighbors.push(labels[(y - 1) * w + (x + 1)]);

        if (neighbors.length === 0) {
          labels[i] = nextLabel;
          parent.push(nextLabel);
          nextLabel++;
        } else {
          var minL = neighbors[0];
          for (var ni = 1; ni < neighbors.length; ni++) if (neighbors[ni] < minL) minL = neighbors[ni];
          labels[i] = minL;
          for (var nj = 0; nj < neighbors.length; nj++) union(minL, neighbors[nj]);
        }
      }
    }

    // Second pass: flatten
    var remap = {};
    var newLabel = 1;
    for (var j = 0; j < n; j++) {
      if (labels[j] === 0) continue;
      var root = find(labels[j]);
      if (!(root in remap)) { remap[root] = newLabel++; }
      labels[j] = remap[root];
    }

    return { labels: labels, count: newLabel - 1 };
  }

  /* ------------------------------------------------------------------ */
  /*  Watershed (marker-based, priority-queue flooding)                  */
  /* ------------------------------------------------------------------ */

  /**
   * Marker-based watershed.
   * markers: Int32Array where >0 = seed label, 0 = unknown.
   * gradient: Float32Array (priority = lower gradient floods first).
   * Returns Int32Array label map (boundary pixels = -1).
   */
  function watershed(markers, gradient, w, h) {
    var cv = _cv();
    if (cv && false) {
      // OpenCV.js watershed requires a 3-channel image as input, which is awkward.
      // We use the pure-JS version for cleaner integration with our gradient map.
    }

    var out = new Int32Array(markers);
    var n = w * h;

    // Simple priority queue (bucket queue for integer priorities)
    var MAX_PRIO = 256;
    var buckets = new Array(MAX_PRIO);
    for (var bi = 0; bi < MAX_PRIO; bi++) buckets[bi] = [];

    function enqueue(index, prio) {
      var p = Math.min(Math.max(Math.round(prio), 0), MAX_PRIO - 1);
      buckets[p].push(index);
    }

    // Seed the queue from marker borders
    var inQueue = new Uint8Array(n);
    var dx4 = [1, -1, 0, 0], dy4 = [0, 0, 1, -1];
    for (var i = 0; i < n; i++) {
      if (out[i] <= 0) continue;
      var ix = i % w, iy = (i / w) | 0;
      for (var d = 0; d < 4; d++) {
        var nx = ix + dx4[d], ny = iy + dy4[d];
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        var ni = ny * w + nx;
        if (out[ni] === 0 && !inQueue[ni]) {
          enqueue(ni, gradient[ni]);
          inQueue[ni] = 1;
        }
      }
    }

    // Flood
    for (var p = 0; p < MAX_PRIO; p++) {
      var bkt = buckets[p];
      for (var qi = 0; qi < bkt.length; qi++) {
        var ci = bkt[qi];
        if (out[ci] !== 0) continue;
        var cx = ci % w, cy = (ci / w) | 0;
        var foundLabel = 0;
        var conflict = false;
        for (var d2 = 0; d2 < 4; d2++) {
          var nx2 = cx + dx4[d2], ny2 = cy + dy4[d2];
          if (nx2 < 0 || nx2 >= w || ny2 < 0 || ny2 >= h) continue;
          var nl = out[ny2 * w + nx2];
          if (nl > 0) {
            if (foundLabel === 0) foundLabel = nl;
            else if (nl !== foundLabel) conflict = true;
          }
        }
        out[ci] = conflict ? -1 : (foundLabel > 0 ? foundLabel : 0);

        // enqueue unlabeled neighbors
        for (var d3 = 0; d3 < 4; d3++) {
          var nx3 = cx + dx4[d3], ny3 = cy + dy4[d3];
          if (nx3 < 0 || nx3 >= w || ny3 < 0 || ny3 >= h) continue;
          var ni2 = ny3 * w + nx3;
          if (out[ni2] === 0 && !inQueue[ni2]) {
            enqueue(ni2, gradient[ni2]);
            inQueue[ni2] = 1;
          }
        }
      }
    }

    // Assign any remaining unlabeled to nearest labeled neighbor
    var remaining = true;
    while (remaining) {
      remaining = false;
      for (var ri = 0; ri < n; ri++) {
        if (out[ri] !== 0) continue;
        remaining = true;
        var rx = ri % w, ry = (ri / w) | 0;
        for (var d4 = 0; d4 < 4; d4++) {
          var nx4 = rx + dx4[d4], ny4 = ry + dy4[d4];
          if (nx4 >= 0 && nx4 < w && ny4 >= 0 && ny4 < h) {
            var nl2 = out[ny4 * w + nx4];
            if (nl2 > 0) { out[ri] = nl2; break; }
          }
        }
      }
    }

    return out;
  }

  /* ------------------------------------------------------------------ */
  /*  Contrast stretch                                                   */
  /* ------------------------------------------------------------------ */

  function contrastStretch(src, n) {
    var lo = 255, hi = 0;
    for (var i = 0; i < n; i++) {
      if (src[i] < lo) lo = src[i];
      if (src[i] > hi) hi = src[i];
    }
    if (hi - lo < 2) return new Uint8Array(src);
    var out = new Uint8Array(n);
    var scale = 255.0 / (hi - lo);
    for (var j = 0; j < n; j++) out[j] = clamp(Math.round((src[j] - lo) * scale), 0, 255);
    return out;
  }

  /* ------------------------------------------------------------------ */
  /*  Public API                                                         */
  /* ------------------------------------------------------------------ */

  global._WFG3_CV = {
    hasOpenCV: function () { return !!_cv(); },
    clamp: clamp,
    resizeGray: resizeGray,
    resizeRGB: resizeRGB,
    gaussianBlur: gaussianBlur,
    bilateralFilter: bilateralFilter,
    rgbToLAB: rgbToLAB,
    sobelGradients: sobelGradients,
    cannyEdge: cannyEdge,
    dilate: dilate,
    erode: erode,
    morphClose: morphClose,
    morphOpen: morphOpen,
    labNeighborDelta: labNeighborDelta,
    distanceTransform: distanceTransform,
    connectedComponents: connectedComponents,
    watershed: watershed,
    contrastStretch: contrastStretch
  };

})(typeof window !== 'undefined' ? window : globalThis);
