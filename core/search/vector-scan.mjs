// E1: Exakter INT8-Flat-Scan im Off-Heap Int8Array Buffer + optionales dateibasiertes FP32 Top-200 Rescoring.
// Bei 200k Vektoren × 384d = nur 76,8 MB Off-Heap (statt 809 MB HNSW-Graph!), 100 % Filter-Recall,
// trivial inkrementell, keine 24h-Kompaktierung.
import fs from 'node:fs';

/**
 * Quantisiert einen L2-normierten Float32-Vektor symmetrisch in Int8 [-127..127] + Skalierungsfaktor.
 */
export function quantizeInt8(vec) {
  let maxAbs = 0;
  for (let i = 0; i < vec.length; i++) {
    const a = Math.abs(vec[i]);
    if (a > maxAbs) maxAbs = a;
  }
  const scale = maxAbs > 0 ? maxAbs / 127 : 1;
  const inv = maxAbs > 0 ? 127 / maxAbs : 0;
  const q = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    const v = Math.round(vec[i] * inv);
    q[i] = v > 127 ? 127 : (v < -127 ? -127 : v);
  }
  return { q, scale };
}

/**
 * Führt einen schnellen exakten INT8-Dot-Product-Scan über alle (oder per Bitmaske gefilterte) Vektoren aus.
 * 8-fach entrollte Schleife nutzt V8 TurboFan optimal aus (~15–60 ms für 150k–250k × 384d).
 */
export class Int8VectorStore {
  constructor({ vectorsPath, scalesPath, fp32Path = null, count, dim = 384 }) {
    this.dim = dim;
    this.count = count;
    this.fp32Path = fp32Path;
    this.fp32Fd = null;

    if (count === 0) {
      this.int8 = new Int8Array(0);
      this.scales = new Float32Array(0);
      return;
    }

    const vBuf = fs.readFileSync(vectorsPath);
    if (vBuf.byteLength !== count * dim) {
      throw new Error(`vectors.i8 Größe fehlerhaft: ${vBuf.byteLength} vs ${count * dim}`);
    }
    // Direkt auf dem Buffer-Speicher (off-heap ArrayBuffer, kein V8-Objekt-Overhead!)
    this.int8 = new Int8Array(vBuf.buffer, vBuf.byteOffset, count * dim);

    const sBuf = fs.readFileSync(scalesPath);
    if (sBuf.byteLength !== count * 4) {
      throw new Error(`scales.f32 Größe fehlerhaft: ${sBuf.byteLength} vs ${count * 4}`);
    }
    this.scales = new Float32Array(sBuf.buffer, sBuf.byteOffset, count);

    if (fp32Path && fs.existsSync(fp32Path)) {
      this.fp32Fd = fs.openSync(fp32Path, 'r');
    }
  }

  close() {
    if (this.fp32Fd !== null) {
      try { fs.closeSync(this.fp32Fd); } catch { /* ignore */ }
      this.fp32Fd = null;
    }
  }

  memoryBytes() {
    return this.int8.byteLength + this.scales.byteLength;
  }

  /**
   * Sucht die `topK` ähnlichsten Slots.
   * `allowedSlots`: optional Uint8Array Bitset (Länge `count`, 1 = erlaubt) oder Array<number> bei sehr engem Filter!
   */
  search(queryF32, { topK = 100, rescoreK = 200, allowedBitset = null, allowedList = null } = {}) {
    const n = this.count;
    const dim = this.dim;
    if (n === 0 || topK <= 0) return [];

    const { q: qInt8, scale: qScale } = quantizeInt8(queryF32);
    const data = this.int8;
    const scales = this.scales;
    const keepK = Math.min(n, Math.max(topK, rescoreK));

    // Min-Heap-Arrays (flach, ohne GC-Druck)
    const heapScores = new Float32Array(keepK);
    const heapIds = new Int32Array(keepK);
    let heapLen = 0;

    const pushCandidate = (id, score) => {
      if (heapLen < keepK) {
        let i = heapLen++;
        heapScores[i] = score;
        heapIds[i] = id;
        // sift-up (Min-Heap)
        while (i > 0) {
          const p = (i - 1) >> 1;
          if (heapScores[p] <= heapScores[i]) break;
          const ts = heapScores[p]; heapScores[p] = heapScores[i]; heapScores[i] = ts;
          const ti = heapIds[p]; heapIds[p] = heapIds[i]; heapIds[i] = ti;
          i = p;
        }
      } else if (score > heapScores[0]) {
        heapScores[0] = score;
        heapIds[0] = id;
        // sift-down
        let i = 0;
        while (true) {
          const l = (i << 1) + 1;
          const r = l + 1;
          let smallest = i;
          if (l < heapLen && heapScores[l] < heapScores[smallest]) smallest = l;
          if (r < heapLen && heapScores[r] < heapScores[smallest]) smallest = r;
          if (smallest === i) break;
          const ts = heapScores[i]; heapScores[i] = heapScores[smallest]; heapScores[smallest] = ts;
          const ti = heapIds[i]; heapIds[i] = heapIds[smallest]; heapIds[smallest] = ti;
          i = smallest;
        }
      }
    };

    const scoreSlot = (slot) => {
      const base = slot * dim;
      let acc = 0;
      let j = 0;
      for (; j + 7 < dim; j += 8) {
        acc +=
          data[base + j] * qInt8[j] +
          data[base + j + 1] * qInt8[j + 1] +
          data[base + j + 2] * qInt8[j + 2] +
          data[base + j + 3] * qInt8[j + 3] +
          data[base + j + 4] * qInt8[j + 4] +
          data[base + j + 5] * qInt8[j + 5] +
          data[base + j + 6] * qInt8[j + 6] +
          data[base + j + 7] * qInt8[j + 7];
      }
      for (; j < dim; j++) acc += data[base + j] * qInt8[j];
      return acc * scales[slot] * qScale;
    };

    if (allowedList) {
      // Sehr selektiver Filter (z. B. ein einzelnes Projekt mit 800 Vektoren): nur diese Liste scannen (< 1 ms!)
      for (let idx = 0; idx < allowedList.length; idx++) {
        const slot = allowedList[idx];
        if (slot >= 0 && slot < n) {
          pushCandidate(slot, scoreSlot(slot));
        }
      }
    } else if (allowedBitset) {
      for (let slot = 0; slot < n; slot++) {
        if (allowedBitset[slot]) {
          pushCandidate(slot, scoreSlot(slot));
        }
      }
    } else {
      for (let slot = 0; slot < n; slot++) {
        pushCandidate(slot, scoreSlot(slot));
      }
    }

    const candidates = new Array(heapLen);
    for (let i = 0; i < heapLen; i++) {
      candidates[i] = { slot: heapIds[i], score: heapScores[i] };
    }

    // Optionales dateibasiertes FP32-Rescoring der Top-Kandidaten (200 × 1,5 KB = 300 KB, < 3 ms)
    if (this.fp32Fd !== null && candidates.length > 0) {
      const rowBytes = dim * 4;
      const tmp = Buffer.allocUnsafe(rowBytes);
      for (let i = 0; i < candidates.length; i++) {
        const slot = candidates[i].slot;
        const read = fs.readSync(this.fp32Fd, tmp, 0, rowBytes, slot * rowBytes);
        if (read === rowBytes) {
          let dot = 0;
          for (let j = 0; j < dim; j++) {
            dot += tmp.readFloatLE(j * 4) * queryF32[j];
          }
          candidates[i].score = dot;
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score || a.slot - b.slot);
    return candidates.slice(0, topK);
  }
}
