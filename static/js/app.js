document.addEventListener('DOMContentLoaded', () => {
    
    // --- タブ切り替え制御 ---
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            // アクティブクラスの入れ替え
            tabBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));

            btn.classList.add('active');
            const targetId = btn.getAttribute('data-target');
            document.getElementById(targetId).classList.add('active');
        });
    });

    // --- オームの法則タブ制御 ---
    const dcInputs = {
        v: document.getElementById('dc-v'),
        i: document.getElementById('dc-i'),
        r: document.getElementById('dc-r'),
        p: document.getElementById('dc-p')
    };
    const dcError = document.getElementById('dc-error');
    const dcClear = document.getElementById('dc-clear');

    function parseInput(inputElement) {
        if (!inputElement) return null;
        const val = inputElement.value.trim();
        return val === '' ? null : parseFloat(val);
    }

    function formatOutput(num) {
        if (num === null || isNaN(num)) return '';
        return Number.isInteger(num) ? num.toString() : num.toLocaleString(undefined, { maximumFractionDigits: 6 });
    }

    function handleDCInput() {
        // UIハイライトリセット
        Object.values(dcInputs).forEach(input => {
            input.parentElement.classList.remove('input-filled', 'input-calculated');
            // 自分が入力した値かフラグ
            if (input.value.trim() !== '') {
                input.parentElement.classList.add('input-filled');
            }
        });
        dcError.textContent = '';

        const vals = {
            v: parseInput(dcInputs.v),
            i: parseInput(dcInputs.i),
            r: parseInput(dcInputs.r),
            p: parseInput(dcInputs.p)
        };

        const { results, error } = CircuitCalculators.calculateDC(vals);

        if (error) {
            dcError.textContent = error;
            return;
        }

        if (results) {
            // 計算結果を反映
            if (vals.v === null) { dcInputs.v.value = formatOutput(results.v); dcInputs.v.parentElement.classList.add('input-calculated'); }
            if (vals.i === null) { dcInputs.i.value = formatOutput(results.i); dcInputs.i.parentElement.classList.add('input-calculated'); }
            if (vals.r === null) { dcInputs.r.value = formatOutput(results.r); dcInputs.r.parentElement.classList.add('input-calculated'); }
            if (vals.p === null) { dcInputs.p.value = formatOutput(results.p); dcInputs.p.parentElement.classList.add('input-calculated'); }
        } else {
            // ユーザーが意図的に文字を消した場合 (入力値が1個以下)、計算済みのセルをクリアする
            const count = Object.values(vals).filter(v => v !== null).length;
            if (count < 2) {
                Object.values(dcInputs).forEach(input => {
                    if (!input.parentElement.classList.contains('input-filled')) {
                         input.value = '';
                    }
                });
            }
        }
    }

    // イベントリスナー登録
    Object.values(dcInputs).forEach(input => {
        input.addEventListener('input', handleDCInput);
    });

    dcClear.addEventListener('click', () => {
        Object.values(dcInputs).forEach(input => {
            input.value = '';
            input.parentElement.classList.remove('input-filled', 'input-calculated');
        });
        dcError.textContent = '';
    });


    // --- 合成抵抗タブ制御 ---
    const resistorListEl = document.getElementById('resistor-list');
    const newResistorInput = document.getElementById('new-resistor');
    const addResistorBtn = document.getElementById('add-resistor');
    const seriesResultEl = document.getElementById('series-result');
    const parallelResultEl = document.getElementById('parallel-result');
    const resistorClearBtn = document.getElementById('resistor-clear');

    let resistorsArray = [];

    function renderResistorList() {
        resistorListEl.innerHTML = '';
        resistorsArray.forEach((r, index) => {
            const li = document.createElement('li');
            li.className = 'resistor-badge';
            li.innerHTML = `R${index + 1}: ${formatOutput(r)}Ω <button class="delete-btn" data-index="${index}"><i class="fa-solid fa-xmark"></i></button>`;
            resistorListEl.appendChild(li);
        });

        // 削除ボタンリスナー
        document.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idx = parseInt(e.currentTarget.getAttribute('data-index'));
                resistorsArray.splice(idx, 1);
                updateSynthesisResult();
            });
        });
    }

    function updateSynthesisResult() {
        const { series, parallel } = CircuitCalculators.calculateSynthesis(resistorsArray);
        seriesResultEl.textContent = formatOutput(series) || '0.00';
        parallelResultEl.textContent = formatOutput(parallel) || '0.00';
        renderResistorList();
    }

    addResistorBtn.addEventListener('click', () => {
        const val = parseInput(newResistorInput);
        if (val !== null && val >= 0) {
            resistorsArray.push(val);
            newResistorInput.value = '';
            newResistorInput.focus();
            updateSynthesisResult();
        } else {
            alert('有効な正の抵抗値を入力してください。');
        }
    });

    // Enterキーでも追加
    newResistorInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') addResistorBtn.click();
    });

    resistorClearBtn.addEventListener('click', () => {
        resistorsArray = [];
        updateSynthesisResult();
    });


    // --- RLC回路タブ制御 ---
    const rlcInputs = {
        r: document.getElementById('rlc-r'),
        l: document.getElementById('rlc-l'),
        c: document.getElementById('rlc-c'),
        f: document.getElementById('rlc-f')
    };
    const rlcResults = {
        z: document.getElementById('rlc-z'),
        phase: document.getElementById('rlc-phase'),
        f0: document.getElementById('rlc-f0')
    };

    function handleRLCInput() {
        const r = parseInput(rlcInputs.r);
        const l = parseInput(rlcInputs.l);
        const c = parseInput(rlcInputs.c);
        const f = parseInput(rlcInputs.f);

        const { z, phase, f0, error } = CircuitCalculators.calculateRLC(r, l, c, f);

        if (error) {
            rlcResults.z.textContent = 'Err';
            rlcResults.phase.textContent = 'Err';
            rlcResults.f0.textContent = 'Err';
            rlcResults.z.parentElement.parentElement.classList.add('error');
        } else if (z !== null) {
            rlcResults.z.textContent = formatOutput(z);
            rlcResults.phase.textContent = formatOutput(phase);
            rlcResults.f0.textContent = formatOutput(f0);
            rlcResults.z.parentElement.parentElement.classList.remove('error');
        } else {
            rlcResults.z.textContent = '---';
            rlcResults.phase.textContent = '---';
            rlcResults.f0.textContent = '---';
        }
    }

    Object.values(rlcInputs).forEach(input => {
        input.addEventListener('input', handleRLCInput);
    });

    // --- Theme Toggle (Phase 10) ---
    const themeToggleBtn = document.getElementById('theme-toggle');
    if (themeToggleBtn) {
        if(localStorage.getItem('theme') === 'light') {
            document.body.classList.add('light-theme');
            themeToggleBtn.innerHTML = '<i class="fa-solid fa-sun"></i>';
        }
        themeToggleBtn.addEventListener('click', () => {
            document.body.classList.toggle('light-theme');
            const isLight = document.body.classList.contains('light-theme');
            localStorage.setItem('theme', isLight ? 'light' : 'dark');
            themeToggleBtn.innerHTML = isLight ? '<i class="fa-solid fa-sun"></i>' : '<i class="fa-solid fa-moon"></i>';
        });
    }

    // --- Auth Logic (Phase 8) ---
    const authLoginBtn = document.getElementById('auth-login-btn');
    const authLogoutBtn = document.getElementById('auth-logout-btn');
    const authUserInfo = document.getElementById('auth-user-info');
    const authUsernameDisplay = document.getElementById('auth-username-display');
    const authModal = document.getElementById('auth-modal');
    const authModalClose = document.getElementById('auth-modal-cancel');
    const authModalSubmit = document.getElementById('auth-modal-submit');
    const authUsernameInput = document.getElementById('auth-username-input');
    const authPasswordInput = document.getElementById('auth-password-input');
    const authErrorMsg = document.getElementById('auth-error-msg');
    
    const tabLogin = document.getElementById('tab-login');
    const tabRegister = document.getElementById('tab-register');
    let isLoginMode = true;

    const saveDbBtn = document.getElementById('schematic-save-db-btn');
    const loadDbBtn = document.getElementById('schematic-load-db-btn');
    const dbCircuitsModal = document.getElementById('db-circuits-modal');
    const dbCircuitsClose = document.getElementById('db-circuits-close');

    function checkAuthStatus() {
        const token = localStorage.getItem('auth_token');
        if (!token) { setLoggedOutState(); return; }
        fetch('/api/me', { headers: { 'Authorization': `Bearer ${token}` } })
        .then(res => { if (!res.ok) throw new Error(); return res.json(); })
        .then(user => { setLoggedInState(user.username); })
        .catch(() => { localStorage.removeItem('auth_token'); setLoggedOutState(); });
    }

    function setLoggedInState(username) {
        authLoginBtn.style.display = 'none';
        authUserInfo.style.display = 'flex';
        authUsernameDisplay.textContent = `User: ${username}`;
        if(saveDbBtn) saveDbBtn.style.display = 'inline-block';
        if(loadDbBtn) loadDbBtn.style.display = 'inline-block';
    }

    function setLoggedOutState() {
        authLoginBtn.style.display = 'inline-block';
        authUserInfo.style.display = 'none';
        if(saveDbBtn) saveDbBtn.style.display = 'none';
        if(loadDbBtn) loadDbBtn.style.display = 'none';
    }

    authLoginBtn.addEventListener('click', () => {
        authModal.classList.add('active');
        authErrorMsg.style.display = 'none';
        authUsernameInput.value = '';
        authPasswordInput.value = '';
        authUsernameInput.focus();
    });

    authModalClose.addEventListener('click', () => authModal.classList.remove('active'));

    tabLogin.addEventListener('click', () => { isLoginMode = true; tabLogin.classList.add('active'); tabRegister.classList.remove('active'); });
    tabRegister.addEventListener('click', () => { isLoginMode = false; tabRegister.classList.add('active'); tabLogin.classList.remove('active'); });

    authModalSubmit.addEventListener('click', async () => {
        const username = authUsernameInput.value.trim();
        const password = authPasswordInput.value;
        if(!username || !password) {
            authErrorMsg.textContent = '入力が空です';
            authErrorMsg.style.display = 'block';
            return;
        }

        const endpoint = isLoginMode ? '/api/login' : '/api/register';
        try {
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({username, password})
            });
            const data = await res.json();
            if(!res.ok) {
                let errorText = 'エラーが発生しました';
                if (Array.isArray(data.detail)) {
                    errorText = '名前: 3〜20文字の半角英数字、パスワード: 8文字以上にしてください';
                } else if (data.detail) {
                    errorText = data.detail;
                }
                authErrorMsg.textContent = errorText;
                authErrorMsg.style.display = 'block';
                return;
            }
            if(!isLoginMode) {
                isLoginMode = true;
                authModalSubmit.click(); // 自動ログイン
            } else {
                localStorage.setItem('auth_token', data.token);
                setLoggedInState(data.username);
                authModal.classList.remove('active');
            }
        } catch(e) {
            authErrorMsg.textContent = 'サーバー通信エラー';
            authErrorMsg.style.display = 'block';
        }
    });

    authLogoutBtn.addEventListener('click', () => {
        localStorage.removeItem('auth_token');
        setLoggedOutState();
    });

    dbCircuitsClose.addEventListener('click', () => dbCircuitsModal.classList.remove('active'));

    checkAuthStatus();

});
