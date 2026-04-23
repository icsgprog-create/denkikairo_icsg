/**
 * 総合電気回路計算 ロジックモジュール
 * 純粋な計算機能のみを提供し、UI操作(DOM)からは独立させます。
 */

const CircuitCalculators = {
    /**
     * オームの法則・直流電力の計算
     * 任意の2つの値(V, I, R, P)から残り2つを計算する
     * @param {Object} inputs - { v: Number|null, i: Number|null, r: Number|null, p: Number|null }
     * @returns {Object} { results: {v, i, r, p}, error: String|null }
     */
    calculateDC(inputs) {
        let { v, i, r, p } = inputs;
        // 定義されている値の数をカウント
        const definedCount = [v, i, r, p].filter(val => val !== null && !isNaN(val)).length;

        if (definedCount < 2) {
            return { results: null, error: null }; // 情報不足
        }
        if (definedCount > 2) {
            return { results: null, error: "値を2つだけ入力してください。" };
        }

        // ゼロ除算等の手動エラーチェック
        if (r === 0) return { results: null, error: "エラー：抵抗値(R)に0は入力できません（短絡状態になります）。" };

        let results = { v: null, i: null, r: null, p: null };

        // 各組み合わせパターンごとの計算式
        if (v !== null && i !== null) {
            if (i === 0) return { results: null, error: "電流が0の場合、抵抗は計算不能です。" };
            results.v = v;
            results.i = i;
            results.r = v / i;
            results.p = v * i;
        } else if (v !== null && r !== null) {
            results.v = v;
            results.r = r;
            results.i = v / r;
            results.p = (v * v) / r;
        } else if (v !== null && p !== null) {
            if (v === 0) return { results: null, error: "電圧0で電力が存在する場合は計算不能です。" };
            results.v = v;
            results.p = p;
            results.i = p / v;
            results.r = (v * v) / p;
        } else if (i !== null && r !== null) {
            results.i = i;
            results.r = r;
            results.v = i * r;
            results.p = i * i * r;
        } else if (i !== null && p !== null) {
            if (i === 0) return { results: null, error: "電流0で電力が存在する場合は計算不能です。" };
            results.i = i;
            results.p = p;
            results.v = p / i;
            results.r = p / (i * i);
        } else if (r !== null && p !== null) {
            if (r < 0) return { results: null, error: "抵抗値は正値である必要があります。" };
            if (p < 0) return { results: null, error: "電力は正値である必要があります。" };
            results.r = r;
            results.p = p;
            results.v = Math.sqrt(p * r);
            results.i = Math.sqrt(p / r);
        }

        return { results, error: null };
    },

    /**
     * 複数抵抗の合成計算（直列・並列）
     * @param {Array<Number>} resistors - 抵抗値の配列
     * @returns {Object} { series: Number, parallel: Number }
     */
    calculateSynthesis(resistors) {
        if (!resistors || resistors.length === 0) return { series: 0, parallel: 0 };
        
        let series = 0;
        let pInvertedSum = 0;
        let hasZero = false;

        resistors.forEach(r => {
            series += r;
            if (r === 0) {
                hasZero = true;
            } else {
                pInvertedSum += (1 / r);
            }
        });

        // 並列で1つでも0Ωがあれば、合成抵抗は0Ω（短絡）
        let parallel = hasZero ? 0 : (1 / pInvertedSum);

        return { series, parallel };
    },

    /**
     * RLC直列回路の基本計算
     * @param {Number} r - 抵抗 (Ohm)
     * @param {Number} l - インダクタンス (mH)
     * @param {Number} c - 静電容量 (uF)
     * @param {Number} f - 周波数 (Hz)
     * @returns {Object} { z: Number, phase: Number, f0: Number, error: String }
     */
    calculateRLC(r, l_mH, c_uF, f) {
        if (r === null || l_mH === null || c_uF === null || f === null) {
            return { z: null, phase: null, f0: null, error: null };
        }
        if (f <= 0) return { z: null, phase: null, f0: null, error: "周波数は0より大きい値を指定してください。" };
        if (r < 0 || l_mH < 0 || c_uF < 0) return { z: null, phase: null, f0: null, error: "負の各種パラメータは指定できません。" };

        const l = l_mH * 1e-3; // Henry
        const c = c_uF * 1e-6; // Farad

        const omega = 2 * Math.PI * f;
        
        const x_l = omega * l;
        const x_c = (c === 0) ? Infinity : 1 / (omega * c);
        const x_total = x_l - x_c;

        const z = Math.sqrt(r * r + x_total * x_total);
        const phase_rad = Math.atan2(x_total, r);
        const phase_deg = phase_rad * (180 / Math.PI);

        // 共振周波数
        const f0 = (l > 0 && c > 0) ? (1 / (2 * Math.PI * Math.sqrt(l * c))) : 0;

        return { z, phase: phase_deg, f0, error: null };
    }
};

// Node.jsモジュール互換性 (テストや将来のバックエンド共用のため)
if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
    module.exports = CircuitCalculators;
}
