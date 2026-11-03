/* Small dense linear algebra for the SSVEP methods: matrices up to ~10×10,
   vectors up to a few thousand samples. */
(function (NP) {
  'use strict';

  function dot(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }

  function center(x) {
    let m = 0;
    for (let i = 0; i < x.length; i++) m += x[i];
    m /= x.length || 1;
    const y = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) y[i] = x[i] - m;
    return y;
  }

  /* Orthonormal basis for the span of the given columns (modified
     Gram-Schmidt, two passes). Numerically dependent columns are dropped. */
  function orthoBasis(cols) {
    const Q = [];
    for (const col of cols) {
      const c = Float64Array.from(col);
      const n0 = Math.sqrt(dot(c, c));
      if (!(n0 > 0)) continue;
      for (let pass = 0; pass < 2; pass++) {
        for (const q of Q) {
          const d = dot(q, c);
          for (let i = 0; i < c.length; i++) c[i] -= d * q[i];
        }
      }
      const n1 = Math.sqrt(dot(c, c));
      if (!(n1 > 1e-8 * n0)) continue;
      for (let i = 0; i < c.length; i++) c[i] /= n1;
      Q.push(c);
    }
    return Q;
  }

  /* Cyclic Jacobi eigen-decomposition of a symmetric matrix.
     vectors[i][j] is component i of eigenvector j. */
  function eigSym(A) {
    const n = A.length;
    const a = A.map((row) => Float64Array.from(row));
    const v = Array.from({ length: n }, (_, i) => { const r = new Float64Array(n); r[i] = 1; return r; });
    for (let sweep = 0; sweep < 60; sweep++) {
      let off = 0, diag = 0;
      for (let p = 0; p < n; p++) {
        diag += a[p][p] * a[p][p];
        for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
      }
      if (off <= 1e-24 * diag || off === 0) break;
      for (let p = 0; p < n - 1; p++) {
        for (let q = p + 1; q < n; q++) {
          const apq = a[p][q];
          if (apq === 0) continue;
          const theta = (a[q][q] - a[p][p]) / (2 * apq);
          const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
          const c = 1 / Math.sqrt(t * t + 1), s = t * c;
          for (let k = 0; k < n; k++) {
            const akp = a[k][p], akq = a[k][q];
            a[k][p] = c * akp - s * akq;
            a[k][q] = s * akp + c * akq;
          }
          for (let k = 0; k < n; k++) {
            const apk = a[p][k], aqk = a[q][k];
            a[p][k] = c * apk - s * aqk;
            a[q][k] = s * apk + c * aqk;
          }
          for (let k = 0; k < n; k++) {
            const vkp = v[k][p], vkq = v[k][q];
            v[k][p] = c * vkp - s * vkq;
            v[k][q] = s * vkp + c * vkq;
          }
        }
      }
    }
    return { values: Array.from({ length: n }, (_, i) => a[i][i]), vectors: v };
  }

  /* Largest canonical correlation between two subspaces, given orthonormal
     bases of each: the largest singular value of Qxᵀ·Qy. */
  function maxCanonicalCorr(Qx, Qy) {
    const p = Qx.length, q = Qy.length;
    if (!p || !q) return 0;
    const M = Qx.map((a) => Qy.map((b) => dot(a, b)));
    const G = [];
    if (p <= q) {
      for (let i = 0; i < p; i++) {
        G.push(new Float64Array(p));
        for (let j = 0; j < p; j++) G[i][j] = dot(M[i], M[j]);
      }
    } else {
      for (let i = 0; i < q; i++) {
        G.push(new Float64Array(q));
        for (let j = 0; j < q; j++) { let s = 0; for (let k = 0; k < p; k++) s += M[k][i] * M[k][j]; G[i][j] = s; }
      }
    }
    const lmax = Math.max(...eigSym(G).values);
    return Math.sqrt(Math.min(1, Math.max(0, lmax)));
  }

  function cholesky(A) {
    const n = A.length;
    const L = Array.from({ length: n }, () => new Float64Array(n));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= i; j++) {
        let s = A[i][j];
        for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
        if (i === j) {
          if (!(s > 0)) return null;
          L[i][i] = Math.sqrt(s);
        } else {
          L[i][j] = s / L[j][j];
        }
      }
    }
    return L;
  }

  function invLower(L) {
    const n = L.length;
    const X = Array.from({ length: n }, () => new Float64Array(n));
    for (let col = 0; col < n; col++) {
      for (let i = 0; i < n; i++) {
        let s = i === col ? 1 : 0;
        for (let k = 0; k < i; k++) s -= L[i][k] * X[k][col];
        X[i][col] = s / L[i][i];
      }
    }
    return X;
  }

  /* Eigenvector for the largest eigenvalue of S·w = λ·Q·w (S symmetric,
     Q symmetric positive definite, lightly regularised). */
  function generalizedMaxEig(S, Q) {
    const n = S.length;
    let tr = 0;
    for (let i = 0; i < n; i++) tr += Q[i][i];
    if (!(tr > 0)) return null;
    const Qr = Q.map((row, i) => { const r = Float64Array.from(row); r[i] += 1e-6 * (tr / n); return r; });
    const L = cholesky(Qr);
    if (!L) return null;
    const Li = invLower(L);
    const T = Li.map((row) => {
      const out = new Float64Array(n);
      for (let j = 0; j < n; j++) { let s = 0; for (let k = 0; k < n; k++) s += row[k] * S[k][j]; out[j] = s; }
      return out;
    });
    const A = T.map((row) => {
      const out = new Float64Array(n);
      for (let j = 0; j < n; j++) { let s = 0; for (let k = 0; k < n; k++) s += row[k] * Li[j][k]; out[j] = s; }
      return out;
    });
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const m = (A[i][j] + A[j][i]) / 2; A[i][j] = m; A[j][i] = m; }
    const { values, vectors } = eigSym(A);
    let best = 0;
    for (let i = 1; i < n; i++) if (values[i] > values[best]) best = i;
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < n; k++) s += Li[k][i] * vectors[k][best]; w[i] = s; }
    return w;
  }

  function pearson(a, b) {
    const n = Math.min(a.length, b.length);
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < n; i++) {
      const x = a[i] - ma, y = b[i] - mb;
      sab += x * y; saa += x * x; sbb += y * y;
    }
    return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
  }

  NP.linalg = { dot, center, orthoBasis, eigSym, maxCanonicalCorr, cholesky, generalizedMaxEig, pearson };
})(window.NP);
