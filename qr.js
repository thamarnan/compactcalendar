'use strict';

/* Minimal QR encoder — byte mode, error-correction level L, mask 0.
   Returns a square matrix of 0/1, or null if the data doesn't fit (v40). */
const QR = (() => {
  // GF(256) arithmetic
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (() => {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const gmul = (a, b) => (a && b) ? EXP[LOG[a] + LOG[b]] : 0;

  function rsGenPoly(n) {
    let poly = [1];
    for (let i = 0; i < n; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= gmul(poly[j], 1);        // x * poly
        next[j + 1] ^= gmul(poly[j], EXP[i]); // α^i * poly
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(data, nEC) {
    const gen = rsGenPoly(nEC);
    const res = data.concat(new Array(nEC).fill(0));
    for (let i = 0; i < data.length; i++) {
      const f = res[i];
      if (!f) continue;
      for (let j = 0; j < gen.length; j++) res[i + j] ^= gmul(gen[j], f);
    }
    return res.slice(data.length);
  }

  // EC level L block structure per version: [ecPerBlock, [[numBlocks, dataCodewords], ...]]
  const EC_L = [null,
    [7,[[1,19]]],[10,[[1,34]]],[15,[[1,55]]],[20,[[1,80]]],[26,[[1,108]]],
    [18,[[2,68]]],[20,[[2,78]]],[24,[[2,97]]],[30,[[2,116]]],[18,[[2,68],[2,69]]],
    [20,[[4,81]]],[24,[[2,92],[2,93]]],[26,[[4,107]]],[30,[[3,115],[1,116]]],[22,[[5,87],[1,88]]],
    [24,[[5,98],[1,99]]],[28,[[1,107],[5,108]]],[30,[[5,120],[1,121]]],[28,[[3,113],[4,114]]],[28,[[3,107],[5,108]]],
    [28,[[4,116],[4,117]]],[28,[[2,111],[7,112]]],[30,[[4,121],[5,122]]],[30,[[6,117],[4,118]]],[26,[[8,106],[4,107]]],
    [28,[[10,114],[2,115]]],[30,[[8,122],[4,123]]],[30,[[3,117],[10,118]]],[30,[[7,116],[7,117]]],[30,[[5,115],[10,116]]],
    [30,[[13,115],[3,116]]],[30,[[17,115]]],[30,[[17,115],[1,116]]],[30,[[13,115],[6,116]]],[30,[[12,121],[7,122]]],
    [30,[[6,121],[14,122]]],[30,[[17,122],[4,123]]],[30,[[4,122],[18,123]]],[30,[[20,117],[4,118]]],[30,[[19,118],[6,119]]],
  ];

  const ALIGN = [null, [],
    [6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],
    [6,30,54],[6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70],[6,26,50,74],[6,30,54,78],[6,30,56,82],[6,30,58,86],[6,34,62,90],
    [6,28,50,72,94],[6,26,50,74,98],[6,30,54,78,102],[6,28,54,80,106],[6,32,58,84,110],[6,30,58,86,114],[6,34,62,90,118],
    [6,26,50,74,98,122],[6,30,54,78,102,126],[6,26,52,78,104,130],[6,30,56,82,108,134],[6,34,60,86,112,138],
    [6,30,58,86,114,142],[6,34,62,90,118,146],[6,30,54,78,102,126,150],[6,24,50,76,102,128,154],[6,28,54,80,106,132,158],
    [6,32,58,84,110,136,162],[6,26,54,82,110,138,166],[6,30,58,86,114,142,170],
  ];

  const dataCapacity = v => EC_L[v][1].reduce((s, [n, len]) => s + n * len, 0);

  function bch(value, poly, polyBits, totalBits) {
    let v = value << (polyBits - 1); // shift by the generator's degree
    for (let i = totalBits; i >= polyBits - 1; i--) {
      if ((v >> i) & 1) v ^= poly << (i - polyBits + 1);
    }
    return v;
  }

  function formatBits(mask) {
    const data = (0b01 << 3) | mask; // EC level L = 01
    const rem = bch(data, 0b10100110111, 11, 14);
    return ((data << 10) | rem) ^ 0b101010000010010;
  }

  function versionBits(ver) {
    const rem = bch(ver, 0b1111100100101, 13, 17);
    return (ver << 12) | rem;
  }

  function encode(text) {
    const bytes = new TextEncoder().encode(text);
    let version = 0;
    for (let v = 1; v <= 40; v++) {
      const cntBits = v < 10 ? 8 : 16;
      if (4 + cntBits + bytes.length * 8 <= dataCapacity(v) * 8) { version = v; break; }
    }
    if (!version) return null;

    const cap = dataCapacity(version);
    const bits = [];
    const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
    push(0b0100, 4);
    push(bytes.length, version < 10 ? 8 : 16);
    for (const b of bytes) push(b, 8);
    const total = cap * 8;
    push(0, Math.min(4, total - bits.length));
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      data.push(b);
    }
    const pads = [0xEC, 0x11];
    for (let i = 0; data.length < cap; i++) data.push(pads[i % 2]);

    // split into blocks, compute EC, interleave
    const [ecLen, groups] = EC_L[version];
    const blocks = [];
    let off = 0;
    for (const [n, len] of groups) {
      for (let i = 0; i < n; i++) {
        const d = data.slice(off, off + len);
        off += len;
        blocks.push({ d, e: rsEncode(d, ecLen) });
      }
    }
    const out = [];
    const maxD = Math.max(...blocks.map(b => b.d.length));
    for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
    for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.e[i]);

    return place(version, out);
  }

  function place(version, codewords) {
    const size = 17 + version * 4;
    const m = Array.from({ length: size }, () => new Array(size).fill(null));

    const finder = (r0, c0) => {
      for (let i = -1; i < 8; i++) {
        for (let j = -1; j < 8; j++) {
          const r = r0 + i, c = c0 + j;
          if (r < 0 || c < 0 || r >= size || c >= size) continue;
          const inF = i >= 0 && i < 7 && j >= 0 && j < 7;
          m[r][c] = inF && (i === 0 || i === 6 || j === 0 || j === 6 || (i >= 2 && i <= 4 && j >= 2 && j <= 4)) ? 1 : 0;
        }
      }
    };
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

    // alignment before timing: an alignment pattern may sit on row/col 6,
    // and must win over the timing pattern there
    for (const r of ALIGN[version]) {
      for (const c of ALIGN[version]) {
        if (m[r][c] != null) continue; // overlaps a finder
        for (let i = -2; i <= 2; i++) {
          for (let j = -2; j <= 2; j++) {
            m[r + i][c + j] = Math.max(Math.abs(i), Math.abs(j)) !== 1 ? 1 : 0;
          }
        }
      }
    }

    for (let i = 8; i < size - 8; i++) {
      if (m[6][i] == null) m[6][i] = i % 2 === 0 ? 1 : 0;
      if (m[i][6] == null) m[i][6] = i % 2 === 0 ? 1 : 0;
    }

    if (version >= 7) {
      const vb = versionBits(version);
      for (let i = 0; i < 18; i++) {
        const b = (vb >> i) & 1;
        m[Math.floor(i / 3)][i % 3 + size - 11] = b;
        m[i % 3 + size - 11][Math.floor(i / 3)] = b;
      }
    }

    // format info (mask 0), placed before data so those cells are reserved
    const fmt = formatBits(0);
    for (let i = 0; i < 15; i++) {
      const b = (fmt >> i) & 1;
      if (i < 6) m[i][8] = b;
      else if (i < 8) m[i + 1][8] = b;
      else m[size - 15 + i][8] = b;
    }
    for (let i = 0; i < 15; i++) {
      const b = (fmt >> i) & 1;
      if (i < 8) m[8][size - i - 1] = b;
      else if (i < 9) m[8][15 - i] = b;
      else m[8][15 - i - 1] = b;
    }
    m[size - 8][8] = 1; // dark module

    // zig-zag data placement with mask 0: (r+c) % 2 === 0
    let inc = -1, row = size - 1, bitIndex = 7, byteIndex = 0;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (;;) {
        for (let c = 0; c < 2; c++) {
          if (m[row][col - c] == null) {
            let dark = byteIndex < codewords.length ? (codewords[byteIndex] >>> bitIndex) & 1 : 0;
            if ((row + (col - c)) % 2 === 0) dark ^= 1;
            m[row][col - c] = dark;
            bitIndex--;
            if (bitIndex === -1) { byteIndex++; bitIndex = 7; }
          }
        }
        row += inc;
        if (row < 0 || row >= size) { row -= inc; inc = -inc; break; }
      }
    }
    return m;
  }

  return { encode };
})();
