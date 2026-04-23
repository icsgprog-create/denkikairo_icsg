/**
 * 回路図描画エンジン (Vanilla JS + SVG) Phase 6
 * A* オートルーティング、過渡解析用チャート描画、パン＆ズーム、保存と読み込み、個別の部品削除機能を統合
 */

document.addEventListener('DOMContentLoaded', () => {
    const svg = document.getElementById('schematic-svg');
    const workspace = document.getElementById('workspace');
    const compLayer = document.getElementById('components-layer');
    const wireLayer = document.getElementById('wires-layer');
    const simLayer = document.getElementById('sim-layer');
    const paletteItems = document.querySelectorAll('.palette-item');
    const clearBtn = document.getElementById('schematic-clear');
    const runSimBtn = document.getElementById('run-simulation');
    const outputContainer = document.getElementById('netlist-output-container');
    const outputPre = document.getElementById('netlist-output');
    
    // Save / Load
    const saveBtn = document.getElementById('schematic-save-btn');
    const loadBtn = document.getElementById('schematic-load-btn');
    const loadInput = document.getElementById('schematic-load-input');

    // Chart.js
    const graphContainer = document.getElementById('graph-container');
    let currentChart = null;

    // Inspector DOM (Phase 10)
    const inspectorPanel = document.getElementById('inspector-panel');
    const inspectorInput = document.getElementById('inspector-val');
    const inspectorRotateBtn = document.getElementById('inspector-rotate');
    const inspectorDeleteBtn = document.getElementById('inspector-delete');
    const inspectorTitle = document.getElementById('inspector-title');

    // Context Menu DOM (Phase 10)
    const contextMenu = document.createElement('div');
    contextMenu.className = 'glass-container';
    contextMenu.style.position = 'absolute';
    contextMenu.style.display = 'none';
    contextMenu.style.padding = '0.5rem 0';
    contextMenu.style.zIndex = '1000';
    contextMenu.style.minWidth = '150px';
    document.body.appendChild(contextMenu);

    document.addEventListener('click', () => {
        contextMenu.style.display = 'none';
    });

    if (!svg || !compLayer || !wireLayer || !workspace) return;

    // --- State ---
    let components = [];
    let wires = [];
    let nextCompId = 1;
    let activeCompForModal = null;
    let selectedComponent = null;
    
    // Wire drawing state
    let isDrawingWire = false;
    let startTerminal = null; 
    let previewWire = null;
    
    // Wire Corner Dragging State
    let isDraggingWireCorner = false;
    let draggingCorner = null; // { wireIndex, pointIndex }

    // --- History State (Undo/Redo) ---
    let history = [];
    let historyIndex = -1;

    function saveState() {
        if (historyIndex < history.length - 1) history = history.slice(0, historyIndex + 1);
        const stateStr = JSON.stringify({
            components: components.map(c => ({
                id: c.id, type: c.type, x: c.x, y: c.y, angle: c.angle, 
                name: c.name, value: c.value
            })),
            wires: wires.map(w => ({
                t1: w.t1, t2: w.t2, path: w.path
            }))
        });
        if (historyIndex >= 0 && history[historyIndex] === stateStr) return; // Prevent duplicate
        history.push(stateStr);
        historyIndex++;
        if (history.length > 50) { history.shift(); historyIndex--; }
    }

    function loadState(stateStr) {
        if (!stateStr) return;
        const data = JSON.parse(stateStr);
        compLayer.innerHTML = '';
        wireLayer.innerHTML = '';
        components = [];
        wires = [];
        selectedComponent = null;

        let maxId = 0;
        data.components.forEach(cData => {
            if (cData.id > maxId) maxId = cData.id;
            const def = ComponentDefs[cData.type];
            if (!def) return;
            const comp = {
                id: cData.id, type: cData.type, def: def,
                x: cData.x, y: cData.y, angle: cData.angle,
                name: cData.name, value: cData.value, elem: null
            };
            components.push(comp);
            renderComponent(comp);
        });
        nextCompId = maxId + 1;
        
        data.wires = data.wires || [];
        data.wires.forEach(wData => wires.push(wData));
        
        updateWires();
        clearSimResults();
    }

    function undo() {
        if (historyIndex > 0) {
            historyIndex--;
            loadState(history[historyIndex]);
        }
    }

    function redo() {
        if (historyIndex < history.length - 1) {
            historyIndex++;
            loadState(history[historyIndex]);
        }
    }

    // Panning & Zooming Engine
    let scale = 1;
    let panX = 100; // 初期オフセット
    let panY = 50;
    let isPanning = false;
    let panStart = {x: 0, y: 0};
    
    workspace.setAttribute('transform', `translate(${panX}, ${panY}) scale(${scale})`);

    // --- Grid Setup ---
    const gridSize = 20;
    function snapToGrid(val) {
        return Math.round(val / gridSize) * gridSize;
    }

    // --- Component Definitions ---
    const ComponentDefs = {
        resistor: {
            width: 60, height: 20, prefix: 'R', defaultValue: '1k',
            draw: () => `<polyline points="0,10 10,10 15,0 25,20 35,0 45,20 50,10 60,10" class="component-shape" fill="none" stroke="white" stroke-width="2"/>`,
            terminals: [{x: 0, y: 10}, {x: 60, y: 10}],
            textOffset: {x: 20, y: -8}
        },
        voltage: {
            width: 40, height: 60, prefix: 'V', defaultValue: '10',
            draw: () => `
                <line x1="20" y1="0" x2="20" y2="25" class="component-shape" stroke="white" stroke-width="2"/>
                <line x1="5" y1="25" x2="35" y2="25" class="component-shape" stroke="white" stroke-width="2"/>
                <line x1="10" y1="35" x2="30" y2="35" class="component-shape" stroke="white" stroke-width="4"/>
                <line x1="20" y1="35" x2="20" y2="60" class="component-shape" stroke="white" stroke-width="2"/>
                <text x="35" y="15" fill="white" font-size="12" class="component-label">+</text>
            `,
            terminals: [{x: 20, y: 0}, {x: 20, y: 60}],
            textOffset: {x: 40, y: 35}
        },
        capacitor: {
            width: 40, height: 40, prefix: 'C', defaultValue: '1u',
            draw: () => `
                <line x1="0" y1="20" x2="15" y2="20" class="component-shape" stroke="white" stroke-width="2"/>
                <line x1="15" y1="5" x2="15" y2="35" class="component-shape" stroke="white" stroke-width="2"/>
                <line x1="25" y1="5" x2="25" y2="35" class="component-shape" stroke="white" stroke-width="2"/>
                <line x1="25" y1="20" x2="40" y2="20" class="component-shape" stroke="white" stroke-width="2"/>
            `,
            terminals: [{x: 0, y: 20}, {x: 40, y: 20}],
            textOffset: {x: 10, y: -5}
        },
        inductor: {
            width: 60, height: 20, prefix: 'L', defaultValue: '1m',
            draw: () => `
                <line x1="0" y1="10" x2="10" y2="10" class="component-shape" stroke="white" stroke-width="2"/>
                <path d="M 10 10 Q 15 0 20 10 Q 25 0 30 10 Q 35 0 40 10 Q 45 0 50 10" class="component-shape" fill="none" stroke="white" stroke-width="2"/>
                <line x1="50" y1="10" x2="60" y2="10" class="component-shape" stroke="white" stroke-width="2"/>
            `,
            terminals: [{x: 0, y: 10}, {x: 60, y: 10}],
            textOffset: {x: 20, y: -5}
        },
        opamp: {
            width: 80, height: 80, prefix: 'U', defaultValue: 'IDEAL',
            draw: () => `
                <polygon points="20,10 20,70 70,40" class="component-shape" fill="none" stroke="white" stroke-width="2"/>
                <text x="25" y="30" fill="white" font-size="14" font-weight="bold">-</text>
                <text x="25" y="60" fill="white" font-size="14" font-weight="bold">+</text>
                <line x1="0" y1="25" x2="20" y2="25" class="component-shape" stroke="white" stroke-width="2"/>
                <line x1="0" y1="55" x2="20" y2="55" class="component-shape" stroke="white" stroke-width="2"/>
                <line x1="70" y1="40" x2="80" y2="40" class="component-shape" stroke="white" stroke-width="2"/>
            `,
            terminals: [{x: 0, y: 25}, {x: 0, y: 55}, {x: 80, y: 40}],
            textOffset: {x: 35, y: 45} // 中心の名称等用
        },
        ground: {
            width: 40, height: 30, prefix: 'GND', defaultValue: '0',
            draw: () => `
                <line x1="20" y1="0" x2="20" y2="15" class="component-shape" stroke="white" stroke-width="2"/>
                <line x1="5" y1="15" x2="35" y2="15" class="component-shape" stroke="white" stroke-width="2"/>
                <line x1="10" y1="22" x2="30" y2="22" class="component-shape" stroke="white" stroke-width="2"/>
                <line x1="15" y1="29" x2="25" y2="29" class="component-shape" stroke="white" stroke-width="2"/>
            `,
            terminals: [{x: 20, y: 0}],
            textOffset: {x: 40, y: 15}
        },
        voltmeter: {
            width: 40, height: 40, prefix: 'Vm', defaultValue: '測',
            draw: () => `
                <circle cx="20" cy="20" r="15" fill="none" class="component-shape" stroke="#f59e0b" stroke-width="2"/>
                <text x="14" y="25" fill="#f59e0b" font-weight="bold" font-family="sans-serif">V</text>
                <line x1="0" y1="20" x2="5" y2="20" class="component-shape" stroke="white" stroke-width="2"/>
                <line x1="35" y1="20" x2="40" y2="20" class="component-shape" stroke="white" stroke-width="2"/>
            `,
            terminals: [{x: 0, y: 20}, {x: 40, y: 20}],
            textOffset: {x: 10, y: -5}
        },
        ammeter: {
            width: 40, height: 40, prefix: 'Am', defaultValue: '測',
            draw: () => `
                <circle cx="20" cy="20" r="15" fill="none" class="component-shape" stroke="#3b82f6" stroke-width="2"/>
                <text x="14" y="25" fill="#3b82f6" font-weight="bold" font-family="sans-serif">A</text>
                <line x1="0" y1="20" x2="5" y2="20" class="component-shape" stroke="white" stroke-width="2"/>
                <line x1="35" y1="20" x2="40" y2="20" class="component-shape" stroke="white" stroke-width="2"/>
            `,
            terminals: [{x: 0, y: 20}, {x: 40, y: 20}],
            textOffset: {x: 10, y: -5}
        },
        switch: {
            width: 60, height: 40, prefix: 'SW', defaultValue: '5',
            draw: () => `
                <line x1="0" y1="20" x2="15" y2="20" class="component-shape" stroke="white" stroke-width="2"/>
                <circle cx="15" cy="20" r="3" fill="none" stroke="white" stroke-width="2"/>
                <line x1="15" y1="17" x2="40" y2="5" class="component-shape" stroke="white" stroke-width="2"/>
                <circle cx="45" cy="20" r="3" fill="none" stroke="white" stroke-width="2"/>
                <line x1="45" y1="20" x2="60" y2="20" class="component-shape" stroke="white" stroke-width="2"/>
            `,
            terminals: [{x: 0, y: 20}, {x: 60, y: 20}],
            textOffset: {x: 20, y: 0}
        },
        text: {
            width: 80, height: 20, prefix: 'TXT', defaultValue: 'Note',
            draw: () => ``, // No visible shape, only text label is drawn via updateLabel()
            terminals: [], // Texts don't connect to wires
            textOffset: {x: 0, y: 15}
        },
        junction: {
            width: 0, height: 0, prefix: 'J', defaultValue: '',
            draw: () => `<circle cx="0" cy="0" r="4" fill="var(--text-primary)" />`,
            terminals: [{x: 0, y: 0}],
            textOffset: {x: 10, y: -10}
        }
    };

    function getTerminalPos(comp, termIdx) {
        if (!comp || !comp.def || !comp.def.terminals[termIdx]) return {x:0, y:0};
        const term = comp.def.terminals[termIdx];
        const cx = comp.def.width / 2;
        const cy = comp.def.height / 2;
        const dx = term.x - cx;
        const dy = term.y - cy;
        const angleRad = comp.angle * Math.PI / 180;
        const rx = dx * Math.cos(angleRad) - dy * Math.sin(angleRad);
        const ry = dx * Math.sin(angleRad) + dy * Math.cos(angleRad);
        return {
            x: comp.x + cx + rx,
            y: comp.y + cy + ry
        };
    }

    function getTerminalExitDir(comp, termIdx) {
        if (!comp || !comp.def || !comp.def.terminals[termIdx]) return {x:0, y:0};
        const term = comp.def.terminals[termIdx];
        const cx = comp.def.width / 2;
        const cy = comp.def.height / 2;
        const dx = term.x - cx;
        const dy = term.y - cy;
        const angleRad = comp.angle * Math.PI / 180;
        const rx = dx * Math.cos(angleRad) - dy * Math.sin(angleRad);
        const ry = dx * Math.sin(angleRad) + dy * Math.cos(angleRad);
        
        if (Math.abs(rx) >= Math.abs(ry)) {
            return { x: rx >= 0 ? 1 : -1, y: 0 };
        } else {
            return { x: 0, y: ry >= 0 ? 1 : -1 };
        }
    }

    // --- Interaction Engine ---
    function getMousePosition(evt) {
        const pt = svg.createSVGPoint();
        pt.x = evt.clientX;
        pt.y = evt.clientY;
        return pt.matrixTransform(workspace.getScreenCTM().inverse());
    }

    // Pan and Zoom Events
    svg.addEventListener('wheel', e => {
        if(e.target.tagName !== 'svg' && e.target.tagName !== 'rect') return; // キャンバス外なら無視
        e.preventDefault();
        const zoomIntensity = 0.05;
        const wheel = e.deltaY < 0 ? 1 : -1;
        const zoomFactor = Math.exp(wheel * zoomIntensity);
        
        const pt = svg.createSVGPoint();
        pt.x = e.clientX;
        pt.y = e.clientY;
        const svgP = pt.matrixTransform(svg.getScreenCTM().inverse());
        
        // ズーム中心の計算
        let newScale = scale * zoomFactor;
        newScale = Math.min(Math.max(0.2, newScale), 3.0);
        
        const scaleChangeRatio = newScale / scale;
        // マウス位置に向けてパンを調整
        panX = svgP.x - (svgP.x - panX) * scaleChangeRatio;
        panY = svgP.y - (svgP.y - panY) * scaleChangeRatio;
        scale = newScale;
        
        workspace.setAttribute('transform', `translate(${panX}, ${panY}) scale(${scale})`);
    });

    svg.addEventListener('mousedown', e => {
        if (e.button === 2 || e.button === 1 || (e.button === 0 && e.target.tagName === 'rect')) {
            isPanning = true;
            panStart = { x: e.clientX, y: e.clientY };
            if(selectedComponent && selectedComponent.elem && e.button===0) {
                selectedComponent.elem.classList.remove('component-selected');
                selectedComponent = null;
                openInspector(null);
            }
        }
    });

    svg.addEventListener('mousemove', e => {
        if (isPanning) {
            const dx = e.clientX - panStart.x;
            const dy = e.clientY - panStart.y;
            panX += dx;
            panY += dy;
            panStart = { x: e.clientX, y: e.clientY };
            workspace.setAttribute('transform', `translate(${panX}, ${panY}) scale(${scale})`);
        } else if (isDrawingWire) {
            const pt = getMousePosition(e);
            let midX = startTerminal.cx + (pt.x - startTerminal.cx) / 2;
            previewWire.setAttribute('points', `${startTerminal.cx},${startTerminal.cy} ${midX},${startTerminal.cy} ${midX},${pt.y} ${pt.x},${pt.y}`);
        } else if (isDraggingWireCorner && draggingCorner) {
            const pt = getMousePosition(e);
            const w = wires[draggingCorner.wireIndex];
            if (w && w.path) {
                w.path[draggingCorner.pointIndex] = {
                    x: snapToGrid(pt.x),
                    y: snapToGrid(pt.y)
                };
                renderWires();
            }
        }
    });

    window.addEventListener('mouseup', () => { 
        isPanning = false; 
        if (isDraggingWireCorner) {
            isDraggingWireCorner = false;
            draggingCorner = null;
            saveState();
        }
        if (isDrawingWire) {
            cleanupPreview(); 
            // In case a wire was drawn and finished via terminal click, it's handled there.
        }
    });
    
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey) {
     // --- Inspector & ContextMenu Logic (Phase 10) ---
    function openInspector(comp) {
        if (!comp || comp.type === 'ground' || comp.type === 'voltmeter' || comp.type === 'ammeter') {
            if(inspectorPanel) inspectorPanel.style.display = 'none';
            activeCompForModal = null;
            return;
        }
        activeCompForModal = comp;
        if(inspectorTitle) inspectorTitle.textContent = `${comp.name} の設定`;
        if(inspectorInput) inspectorInput.value = comp.value;
        if(inspectorPanel) {
            inspectorPanel.style.display = 'flex';
            inspectorInput.focus();
        }
    }

    if(inspectorInput) {
        inspectorInput.addEventListener('change', () => {
            if (activeCompForModal) {
                activeCompForModal.value = inspectorInput.value;
                const valLabel = activeCompForModal.elem.querySelector('.comp-val-label');
                if (valLabel) {
                     let unit = '';
                     if(activeCompForModal.type === 'resistor') unit = 'Ω';
                     if(activeCompForModal.type === 'voltage') unit = 'V';
                     if(activeCompForModal.type === 'switch') unit = 'ms';
                     if(activeCompForModal.type === 'text') { valLabel.textContent = activeCompForModal.value; } 
                     else { valLabel.textContent = activeCompForModal.value + unit; }
                }
                saveState();
            }
        });
        inspectorInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') inspectorInput.blur();
        });
    }

    function rotateComponent(comp) {
        if (!comp) return;
        comp.angle = (comp.angle + 90) % 360;
        const cx = comp.def.width / 2;
        const cy = comp.def.height / 2;
        comp.elem.setAttribute('transform', `translate(${comp.x}, ${comp.y}) rotate(${comp.angle}, ${cx}, ${cy})`);
        
        wires.forEach(w => {
            if (w.t1.compId === comp.id || w.t2.compId === comp.id) w.path = null;
        });
        
        updateWires();
        clearSimResults();
        saveState();
    }

    if (inspectorRotateBtn) {
        inspectorRotateBtn.addEventListener('click', () => {
            if (activeCompForModal) rotateComponent(activeCompForModal);
        });
    }

    function removeComponent(comp) {
        if(!comp) return;
        // 紐づくワイヤーを削除
        wires = wires.filter(w => w.t1.compId !== comp.id && w.t2.compId !== comp.id);
        components = components.filter(c => c.id !== comp.id);
        if(comp.elem && comp.elem.parentNode) comp.elem.parentNode.removeChild(comp.elem);
        selectedComponent = null;
        updateWires();
        clearSimResults();
        saveState();
    }

    if (inspectorDeleteBtn) {
        inspectorDeleteBtn.addEventListener('click', () => {
            if (activeCompForModal) removeComponent(activeCompForModal);
            openInspector(null);
        });
    }

    document.addEventListener('keydown', (e) => {
        // 回転
        if ((e.key === 'r' || e.key === 'R') && selectedComponent && document.activeElement !== inspectorInput) {
            rotateComponent(selectedComponent);
        }
        // コンポーネント削除 (Delete / Backspace)
        if ((e.key === 'Delete' || e.key === 'Backspace') && selectedComponent && document.activeElement !== inspectorInput) {
            removeComponent(selectedComponent);
            openInspector(null);
        }
    });

    function showContextMenu(e, comp) {
        e.preventDefault();
        e.stopPropagation();
        selectedComponent = comp;
        openInspector(comp);
        
        contextMenu.innerHTML = `
            <div class="menu-item" id="cmenu-rotate"><i class="fa-solid fa-rotate-right"></i> 90°回転 (R)</div>
            <div class="menu-item" id="cmenu-delete" style="color:#ef4444;"><i class="fa-solid fa-trash"></i> 削除 (Del)</div>
        `;
        contextMenu.style.display = 'block';
        contextMenu.style.left = e.clientX + 'px';
        contextMenu.style.top = e.clientY + 'px';

        document.getElementById('cmenu-rotate').addEventListener('click', () => rotateComponent(comp));
        document.getElementById('cmenu-delete').addEventListener('click', () => {
            removeComponent(comp);
            openInspector(null);
        });
    }
        // キャンセル
        if (e.key === 'Escape') {
            if (selectedComponent && selectedComponent.elem) {
                selectedComponent.elem.classList.remove('component-selected');
                selectedComponent = null;
            }
            closeModal();
            cleanupPreview();
        }
    });

    // --- Drag and Drop ---
    paletteItems.forEach(item => {
        item.addEventListener('dragstart', e => {
            e.dataTransfer.setData('type', item.dataset.type);
            const rect = item.getBoundingClientRect();
            e.dataTransfer.setData('offsetX', e.clientX - rect.left);
            e.dataTransfer.setData('offsetY', e.clientY - rect.top);
        });
    });

    svg.addEventListener('dragover', e => e.preventDefault());

    svg.addEventListener('drop', e => {
        e.preventDefault();
        const type = e.dataTransfer.getData('type');
        if (!type || !ComponentDefs[type]) return;

        const pt = getMousePosition(e);
        const x = snapToGrid(pt.x - gridSize);
        const y = snapToGrid(pt.y - gridSize);

        addComponent(type, x, y);
        saveState();
    });

    function createComponentDOM(comp) {
        const def = comp.def;
        const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
        const cx = def.width / 2;
        const cy = def.height / 2;
        g.setAttribute('transform', `translate(${comp.x}, ${comp.y}) rotate(${comp.angle}, ${cx}, ${cy})`);
        
        g.setAttribute('class', 'component-group');
        g.dataset.id = comp.id;

        const hitBoxHTML = `<rect x="-15" y="-15" width="${def.width + 30}" height="${def.height + 30}" fill="transparent" class="component-hitbox" cursor="move"/>`;
        g.innerHTML = hitBoxHTML + def.draw();

        const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
        label.setAttribute('x', 0);
        label.setAttribute('y', -5);
        label.setAttribute('class', 'component-label');
        label.textContent = comp.name;
        g.appendChild(label);

        if (comp.type !== 'ground' && comp.type !== 'voltmeter' && comp.type !== 'ammeter') {
            const valLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
            valLabel.setAttribute('x', def.textOffset.x);
            valLabel.setAttribute('y', def.textOffset.y);
            valLabel.setAttribute('class', 'component-label comp-val-label');
            
            if (comp.type === 'text') {
                label.style.display = 'none'; // hide prefix name
                valLabel.setAttribute('font-size', '16');
                valLabel.style.fill = 'var(--text-primary)';
                valLabel.textContent = comp.value;
            } else {
                valLabel.style.fill = 'var(--text-secondary)';
                valLabel.textContent = comp.value + (comp.type==='resistor'?'Ω':comp.type==='voltage'?'V':'');
            }
            g.appendChild(valLabel);
        }

        g.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            openInspector(comp);
        });

        def.terminals.forEach((term, index) => {
            const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            circle.setAttribute('cx', term.x);
            circle.setAttribute('cy', term.y);
            circle.setAttribute('r', 4);
            circle.setAttribute('class', 'node-point');
            circle.dataset.compId = comp.id;
            circle.dataset.termIdx = index;
            
            circle.addEventListener('mousedown', (e) => {
                const pos = getTerminalPos(comp, index);
                startWire(e, comp.id, index, pos.x, pos.y);
            });
            circle.addEventListener('mouseup', (e) => {
                const pos = getTerminalPos(comp, index);
                finishWire(e, comp.id, index, pos.x, pos.y);
            });
            
            g.appendChild(circle);
        });

        let isDragging = false;
        let startPos = {x:0, y:0};

        g.addEventListener('mousedown', e => {
            if (e.target.classList.contains('node-point')) return;
            if (e.button === 2) {
                showContextMenu(e, comp);
                return;
            }
            if (e.button !== 0) return;
            
            isDragging = true;
            
            if (selectedComponent && selectedComponent.elem) {
                selectedComponent.elem.classList.remove('component-selected');
            }
            selectedComponent = comp;
            g.classList.add('component-selected');
            openInspector(comp);

            const pt = getMousePosition(e);
            startPos = { x: pt.x - comp.x, y: pt.y - comp.y };
        });
        
        g.addEventListener('contextmenu', e => e.preventDefault());

        document.addEventListener('mousemove', e => {
            if (!isDragging) return;
            const pt = getMousePosition(e);
            comp.x = snapToGrid(pt.x - startPos.x);
            comp.y = snapToGrid(pt.y - startPos.y);
            comp.elem.setAttribute('transform', `translate(${comp.x}, ${comp.y}) rotate(${comp.angle}, ${cx}, ${cy})`);
            
            wires.forEach(w => {
                if (w.t1.compId === comp.id || w.t2.compId === comp.id) w.path = null;
            });
            
            updateWires();
            clearSimResults();
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                saveState();
            }
        });

        return g;
    }

    function addComponent(type, x, y, angle=0, value=undefined, id=undefined, name=undefined) {
        const def = ComponentDefs[type];
        const comp = {
            id: id !== undefined ? id : nextCompId++,
            type: type,
            name: name !== undefined ? name : `${def.prefix}${nextCompId - 1}`,
            value: value !== undefined ? value : def.defaultValue,
            x: x, y: y,
            angle: angle,
            def: def,
            nodeIds: [] 
        };
        comp.elem = createComponentDOM(comp);
        components.push(comp);
        compLayer.appendChild(comp.elem);
        clearSimResults();
        
        if(comp.id >= nextCompId) nextCompId = comp.id + 1;
        return comp;
    }

    // --- Wire Drawing using A* Manhattan Routing ---

    function startWire(e, compId, termIdx, tX, tY) {
        e.stopPropagation();
        isDrawingWire = true;
        startTerminal = { compId, termIdx, cx: tX, cy: tY };

        previewWire = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
        previewWire.setAttribute('class', 'wire');
        previewWire.setAttribute('stroke-dasharray', '5,5');
        wireLayer.appendChild(previewWire);
        clearSimResults();
    }

    function finishWire(e, compId, termIdx, tX, tY) {
        e.stopPropagation();
        if (!isDrawingWire) return;
        
        if (startTerminal.compId === compId && startTerminal.termIdx === termIdx) {
            cleanupPreview(); return;
        }

        const wire = {
            t1: { compId: startTerminal.compId, termIdx: startTerminal.termIdx },
            t2: { compId: compId, termIdx: termIdx },
            path: null
        };
        wires.push(wire);
        
        renderWires();
        cleanupPreview();
    }

    function cleanupPreview() {
        isDrawingWire = false;
        startTerminal = null;
        if (previewWire) {
            wireLayer.removeChild(previewWire);
            previewWire = null;
        }
    }

    // --- Pattern Router with Stubs and Obstacle Avoidance ---
    function findBeautifulPath(comp1, termIdx1, comp2, termIdx2) {
        const t1 = getTerminalPos(comp1, termIdx1);
        const t2 = getTerminalPos(comp2, termIdx2);
        const dir1 = getTerminalExitDir(comp1, termIdx1);
        const dir2 = getTerminalExitDir(comp2, termIdx2);
        
        // 20pxのスタブ（引き出し線）を確保し、部品から直角に離脱させる
        const p1 = { x: t1.x + dir1.x * 20, y: t1.y + dir1.y * 20 };
        const p2 = { x: t2.x + dir2.x * 20, y: t2.y + dir2.y * 20 };

        // 障害物のバウンディングボックス計算 (10pxのパディング)
        const obstacles = components.map(c => {
            const isVertical = (c.angle % 180 !== 0);
            const w = isVertical ? c.def.height : c.def.width;
            const h = isVertical ? c.def.width : c.def.height;
            const cx = c.def.width / 2;
            const cy = c.def.height / 2;
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            const corners = [{x:0, y:0}, {x:c.def.width, y:0}, {x:0, y:c.def.height}, {x:c.def.width, y:c.def.height}];
            corners.forEach(pt => {
                const angleRad = c.angle * Math.PI / 180;
                const rx = (pt.x - cx) * Math.cos(angleRad) - (pt.y - cy) * Math.sin(angleRad);
                const ry = (pt.x - cx) * Math.sin(angleRad) + (pt.y - cy) * Math.cos(angleRad);
                const sx = c.x + cx + rx;
                const sy = c.y + cy + ry;
                if(sx < minX) minX = sx; if(sx > maxX) maxX = sx;
                if(sy < minY) minY = sy; if(sy > maxY) maxY = sy;
            });
            return { left: minX - 10, right: maxX + 10, top: minY - 10, bottom: maxY + 10 };
        });

        function hitTestLineRect(x1, y1, x2, y2, rect) {
            if (x1 === x2) {
                if (x1 > rect.left && x1 < rect.right) {
                    if (Math.max(y1, y2) > rect.top && Math.min(y1, y2) < rect.bottom) return true;
                }
            } else {
                if (y1 > rect.top && y1 < rect.bottom) {
                    if (Math.max(x1, x2) > rect.left && Math.min(x1, x2) < rect.right) return true;
                }
            }
            return false;
        }

        function countCollisions(pts) {
            let hits = 0;
            for(let i=0; i<pts.length-1; i++) {
                for(let rect of obstacles) {
                    if (hitTestLineRect(pts[i].x, pts[i].y, pts[i+1].x, pts[i+1].y, rect)) hits++;
                }
            }
            return hits;
        }

        // Z-Shape / L-Shape の候補パスを生成
        const midX = p1.x + (p2.x - p1.x) / 2;
        const midY = p1.y + (p2.y - p1.y) / 2;
        
        const candidatePaths = [
            // Z-Shape X split
            [{x: p1.x, y: p1.y}, {x: midX, y: p1.y}, {x: midX, y: p2.y}, {x: p2.x, y: p2.y}],
            // Z-Shape Y split
            [{x: p1.x, y: p1.y}, {x: p1.x, y: midY}, {x: p2.x, y: midY}, {x: p2.x, y: p2.y}],
            // L-Shape 1
            [{x: p1.x, y: p1.y}, {x: p2.x, y: p1.y}, {x: p2.x, y: p2.y}],
            // L-Shape 2
            [{x: p1.x, y: p1.y}, {x: p1.x, y: p2.y}, {x: p2.x, y: p2.y}],
            // Extended routing (U-Shape)
            [{x: p1.x, y: p1.y}, {x: p1.x, y: Math.min(p1.y, p2.y) - 60}, {x: p2.x, y: Math.min(p1.y, p2.y) - 60}, {x: p2.x, y: p2.y}],
            [{x: p1.x, y: p1.y}, {x: p1.x, y: Math.max(p1.y, p2.y) + 60}, {x: p2.x, y: Math.max(p1.y, p2.y) + 60}, {x: p2.x, y: p2.y}]
        ];

        let bestPath = null;
        let minHits = Infinity;
        let minLen = Infinity;

        candidatePaths.forEach(path => {
            let hits = countCollisions(path);
            let len = 0;
            for(let i=0; i<path.length-1; i++) {
                len += Math.abs(path[i].x - path[i+1].x) + Math.abs(path[i].y - path[i+1].y);
            }
            if (hits < minHits || (hits === minHits && len < minLen)) {
                minHits = hits;
                minLen = len;
                bestPath = path;
            }
        });

        // 重複する点を取り除き、スタブを前後に結合
        let finalPath = [t1, p1, ...bestPath, p2, t2];
        let simplified = [finalPath[0]];
        for (let i = 1; i < finalPath.length - 1; i++) {
            const prev = finalPath[i-1];
            const curr = finalPath[i];
            const next = finalPath[i+1];
            if ((prev.x === curr.x && curr.x === next.x) || (prev.y === curr.y && curr.y === next.y)) continue;
            simplified.push(curr);
        }
        simplified.push(finalPath[finalPath.length - 1]);
        
        return simplified;
    }

    function renderWires() {
        wireLayer.innerHTML = '';
        wires.forEach((wire, i) => {
            const comp1 = components.find(c => c.id === wire.t1.compId);
            const comp2 = components.find(c => c.id === wire.t2.compId);
            if (!comp1 || !comp2) return;

            if (!wire.path) {
                wire.path = findBeautifulPath(comp1, wire.t1.termIdx, comp2, wire.t2.termIdx);
            } else {
                // Ensure ends stay glued to terminals
                wire.path[0] = getTerminalPos(comp1, wire.t1.termIdx);
                wire.path[wire.path.length-1] = getTerminalPos(comp2, wire.t2.termIdx);
            }

            const pointsStr = wire.path.map(p => `${p.x},${p.y}`).join(' ');
            
            const poly = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
            poly.setAttribute('class', 'wire');
            poly.setAttribute('points', pointsStr);
            
            poly.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                wires.splice(i, 1);
                renderWires();
                clearSimResults();
                saveState();
            });

            // T-junction splitting
            poly.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                const pt = getMousePosition(e);
                const snX = snapToGrid(pt.x), snY = snapToGrid(pt.y);
                
                const jComp = {
                    id: nextCompId++, type: 'junction', def: ComponentDefs['junction'],
                    x: snX, y: snY, angle: 0, name: 'J' + nextCompId, value: '', elem: null
                };
                components.push(jComp);
                renderComponent(jComp);
                
                const newWire1 = { t1: wire.t1, t2: {compId: jComp.id, termIdx: 0}, path: null };
                const newWire2 = { t1: {compId: jComp.id, termIdx: 0}, t2: wire.t2, path: null };
                wires.splice(i, 1, newWire1, newWire2);
                
                isDrawingWire = true;
                startTerminal = { compId: jComp.id, termIdx: 0, cx: snX, cy: snY };
                previewWire = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
                previewWire.setAttribute('class', 'wire preview');
                wireLayer.appendChild(previewWire);
                renderWires();
                saveState();
            });

            wireLayer.appendChild(poly);

            // Draw handles at corners
            for(let pIdx = 1; pIdx < wire.path.length - 1; pIdx++) {
                const pt = wire.path[pIdx];
                const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
                circle.setAttribute('cx', pt.x);
                circle.setAttribute('cy', pt.y);
                circle.setAttribute('r', 4);
                circle.setAttribute('class', 'wire-handle');
                
                circle.addEventListener('mousedown', (e) => {
                    if(e.button !== 0) return;
                    e.stopPropagation();
                    isDraggingWireCorner = true;
                    draggingCorner = { wireIndex: i, pointIndex: pIdx };
                    isPanning = false; 
                });
                
                circle.addEventListener('dblclick', (e) => {
                    e.stopPropagation();
                    wires.splice(i, 1);
                    renderWires();
                    clearSimResults();
                    saveState();
                });
                
                wireLayer.appendChild(circle);
            }
        });
    }

    function updateWires() { renderWires(); }

    function clearSimResults() {
        if (simLayer) simLayer.innerHTML = '';
    }

    // --- UI actions ---
    clearBtn.addEventListener('click', () => {
        compLayer.innerHTML = '';
        wireLayer.innerHTML = '';
        clearSimResults();
        components = [];
        wires = [];
        nextCompId = 1;
        selectedComponent = null;
        outputContainer.style.display = 'none';
        if (graphContainer) graphContainer.style.display = 'none';
        saveState();
    });

    // --- Save / Load (JSON Export/Import & Cloud) ---
    const saveDbBtn = document.getElementById('schematic-save-db-btn');
    const loadDbBtn = document.getElementById('schematic-load-db-btn');
    const dbCircuitsModal = document.getElementById('db-circuits-modal');
    const dbCircuitsList = document.getElementById('db-circuits-list');

    if (saveDbBtn) {
        saveDbBtn.addEventListener('click', async () => {
            const token = localStorage.getItem('auth_token');
            if(!token) { alert("ログインしてください"); return; }
            
            const name = prompt("クラウドに保存する回路名を入力してください", "新らしい回路");
            if(!name) return;
            
            const dataStr = JSON.stringify({
                version: "1.0",
                panX: panX, panY: panY, scale: scale,
                components: components.map(c => ({
                    id: c.id, type: c.type, name: c.name, value: c.value, x: c.x, y: c.y, angle: c.angle
                })),
                wires: wires
            });

            try {
                const res = await fetch('/api/circuits', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({ name: name, json_data: dataStr })
                });
                if(!res.ok) throw new Error();
                alert("クラウドに保存しました！");
            } catch(e) {
                alert("保存通信エラー");
            }
        });
    }

    if (loadDbBtn) {
        loadDbBtn.addEventListener('click', async () => {
            const token = localStorage.getItem('auth_token');
            if(!token) { alert("ログインしてください"); return; }

            dbCircuitsList.innerHTML = '<p>読み込み中...</p>';
            dbCircuitsModal.classList.add('active');

            try {
                const res = await fetch('/api/circuits', {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                if(!res.ok) throw new Error();
                const circuits = await res.json();
                
                dbCircuitsList.innerHTML = '';
                if(circuits.length === 0) {
                    dbCircuitsList.innerHTML = '<p style="color:var(--text-secondary);">保存された回路はありません。</p>';
                    return;
                }

                circuits.forEach(c => {
                    const item = document.createElement('div');
                    item.style.display = 'flex';
                    item.style.justifyContent = 'space-between';
                    item.style.padding = '10px';
                    item.style.background = 'rgba(255,255,255,0.05)';
                    item.style.borderRadius = '8px';
                    item.innerHTML = `
                        <div style="flex:1;">
                            <strong style="color:var(--text-primary); font-size:1.1rem;">${c.name}</strong><br>
                            <span style="font-size:0.8rem; color:var(--text-secondary);">ID: ${c.id}</span>
                        </div>
                        <div style="display:flex; gap:10px; align-items:center;">
                            <button class="btn accent load-item-btn"><i class="fa-solid fa-cloud-arrow-down"></i> 読込</button>
                            <button class="btn secondary delete-item-btn"><i class="fa-solid fa-trash"></i></button>
                        </div>
                    `;
                    
                    item.querySelector('.load-item-btn').addEventListener('click', () => {
                        const data = JSON.parse(c.json_data);
                        clearBtn.click();
                        if(data.panX !== undefined) {
                            panX = data.panX; panY = data.panY; scale = data.scale;
                            workspace.setAttribute('transform', `translate(${panX}, ${panY}) scale(${scale})`);
                        }
                        if(data.components) {
                            data.components.forEach(cmp => addComponent(cmp.type, cmp.x, cmp.y, cmp.angle, cmp.value, cmp.id, cmp.name));
                        }
                        if(data.wires) {
                            data.wires.forEach(w => wires.push({ t1: w.t1, t2: w.t2, path: w.path }));
                        }
                        updateWires();
                        saveState();
                        dbCircuitsModal.classList.remove('active');
                    });

                    item.querySelector('.delete-item-btn').addEventListener('click', async () => {
                        if(!confirm(`「${c.name}」を削除しますか？`)) return;
                        try {
                            const delRes = await fetch(`/api/circuits/${c.id}`, {
                                method: 'DELETE',
                                headers: { 'Authorization': `Bearer ${token}` }
                            });
                            if(!delRes.ok) throw new Error();
                            item.remove();
                            if(dbCircuitsList.children.length === 0) dbCircuitsList.innerHTML = '<p style="color:var(--text-secondary);">保存された回路はありません。</p>';
                        } catch(e) {
                            alert("削除に失敗しました");
                        }
                    });
                    
                    dbCircuitsList.appendChild(item);
                });
            } catch(e) {
                dbCircuitsList.innerHTML = '<p style="color:#ef4444;">通信エラーが発生しました。</p>';
            }
        });
    }

    if(saveBtn) {
        saveBtn.addEventListener('click', () => {
            const data = {
                version: "1.0",
                panX: panX, panY: panY, scale: scale,
                components: components.map(c => ({
                    id: c.id, type: c.type, name: c.name, value: c.value, x: c.x, y: c.y, angle: c.angle
                })),
                wires: wires
            };
            const jsonStr = JSON.stringify(data, null, 2);
            const blob = new Blob([jsonStr], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "circuit.json";
            a.click();
            URL.revokeObjectURL(url);
        });
    }

    if(loadBtn && loadInput) {
        loadBtn.addEventListener('click', () => loadInput.click());
        loadInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if(!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    const data = JSON.parse(ev.target.result);
                    clearBtn.click(); // Reset everything
                    
                    if(data.panX !== undefined && data.panY !== undefined && data.scale !== undefined) {
                        panX = data.panX; panY = data.panY; scale = data.scale;
                        workspace.setAttribute('transform', `translate(${panX}, ${panY}) scale(${scale})`);
                    }
                    
                    if(data.components) {
                        data.components.forEach(c => addComponent(c.type, c.x, c.y, c.angle, c.value, c.id, c.name));
                    }
                    if(data.wires) {
                        wires = data.wires;
                        renderWires();
                    }
                } catch(err) {
                    alert("無効な回路ファイルです。 " + err);
                }
                loadInput.value = "";
            };
            reader.readAsText(file);
        });
    }


    // --- Simulation & MNA Python Integration ---
    runSimBtn.addEventListener('click', async () => {
        let parent = {};
        function find(i) {
            if (parent[i] === undefined) parent[i] = i;
            if (parent[i] === i) return i;
            return parent[i] = find(parent[i]);
        }
        function union(i, j) { parent[find(i)] = find(j); }

        wires.forEach(w => {
            const t1 = `${w.t1.compId}_${w.t1.termIdx}`;
            const t2 = `${w.t2.compId}_${w.t2.termIdx}`;
            union(t1, t2);
        });

        let nodeMap = {}; 
        let nextNodeInt = 1;

        // Ground is node 0
        components.forEach(c => {
            if (c.type === 'ground') {
                const tId = `${c.id}_0`;
                nodeMap[find(tId)] = 0;
            }
        });

        components.forEach(c => {
            c.nodeIds = [];
            c.def.terminals.forEach((t, index) => {
                const root = find(`${c.id}_${index}`);
                if (nodeMap[root] === undefined) {
                    nodeMap[root] = nextNodeInt++;
                }
                c.nodeIds.push(nodeMap[root]);
            });
        });

        const netlist = components.map(c => {
            return {
                name: c.name,
                type: c.type,
                nodes: c.nodeIds,
                value: c.value
            };
        });

        try {
            outputContainer.style.display = 'block';
            outputPre.textContent = '解析中...';
            
            const response = await fetch('/api/v1/solve-advanced', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ netlist })
            });
            const data = await response.json();
            
            outputPre.textContent = JSON.stringify(data, null, 2);

            if (data.status === 'success') {
                visualizeResults(data);
                
                if (data.transient_data) {
                    graphContainer.style.display = 'block';
                    renderChart(data.transient_data);
                } else {
                    graphContainer.style.display = 'none';
                }
            } else {
                alert('解析エラー: ' + data.message);
                clearSimResults();
                graphContainer.style.display = 'none';
            }

        } catch (err) {
            console.error(err);
            alert('Pythonサーバーとの通信に失敗しました。');
        }
    });

    function visualizeResults(data) {
        clearSimResults();

        const nodeVoltages = data.node_voltages || {};
        const compResults = data.components || {};
        const drawnNodes = new Set();

        components.forEach(c => {
            c.def.terminals.forEach((term, index) => {
                const nId = c.nodeIds[index];
                if (nId === undefined || drawnNodes.has(nId)) return;
                drawnNodes.add(nId);
                
                const pos = getTerminalPos(c, index);
                const voltage = nodeVoltages[nId];
                if (voltage === undefined) return;

                const txt = document.createElementNS("http://www.w3.org/2000/svg", "text");
                txt.setAttribute('x', pos.x + 8);
                txt.setAttribute('y', pos.y - 8);
                txt.setAttribute('class', 'sim-result-text');
                txt.textContent = `${voltage}V`;
                simLayer.appendChild(txt);
            });

            const res = compResults[c.name];
            if (res) {
                const isMeter = c.type === 'voltmeter' || c.type === 'ammeter';
                const midX = c.x + (c.def.width / 2);
                let midY = c.y + c.def.height + 25; 
                if (isMeter) midY = c.y + c.def.height + 15;

                const txt = document.createElementNS("http://www.w3.org/2000/svg", "text");
                txt.setAttribute('x', midX - 15);
                txt.setAttribute('y', midY);
                txt.setAttribute('class', `sim-result-text sim-result-current ${isMeter ? 'sim-result-meter' : ''}`);
                
                if (c.type === 'voltmeter') {
                    txt.textContent = `${Math.abs(res.v_drop).toFixed(3)}V`;
                } else if (c.type !== 'opamp') {
                    // Current readout for normal components. (Opamp model doesn't output current easily in current setup, skipping)
                    let iVal = res.current;
                    let iStr = '';
                    if (Math.abs(iVal) >= 1) iStr = iVal.toFixed(3) + 'A';
                    else if (Math.abs(iVal) >= 1e-3) iStr = (iVal*1e3).toFixed(3) + 'mA';
                    else if (Math.abs(iVal) >= 1e-6) iStr = (iVal*1e6).toFixed(3) + 'uA';
                    else iStr = '0A';
                    txt.textContent = `${iStr}`;
                }
                simLayer.appendChild(txt);
            }
        });
        
        // Phase 10: Current Flow Animation
        document.querySelectorAll('.wire').forEach(w => w.classList.add('animated'));
    }

    // --- Chart Generation ---
    function renderChart(tranData) {
        const ctx = document.getElementById('sim-chart').getContext('2d');
        if (currentChart) currentChart.destroy();
        
        const datasets = [];
        const times = tranData.time.map(t => (t * 1000).toFixed(2));
        
        const colors = ['#f87171', '#60a5fa', '#34d399', '#fbbf24', '#a78bfa'];
        let colorIdx = 0;
        
        for (const [nodeId, values] of Object.entries(tranData.nodes)) {
            datasets.push({
                label: `Node ${nodeId} Voltage (V)`,
                data: values,
                borderColor: colors[colorIdx % colors.length],
                borderWidth: 2,
                tension: 0.1,
                pointRadius: 0
            });
            colorIdx++;
        }
        
        currentChart = new Chart(ctx, {
            type: 'line',
            data: { labels: times, datasets: datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: { title: { display: true, text: 'Time (ms)', color: '#fff' }, ticks:{color:'#fff'} },
                    y: { title: { display: true, text: 'Voltage (V)', color: '#fff' }, ticks:{color:'#fff'} }
                },
                plugins: { legend: { labels: { color: '#fff' } } }
            }
        });
    }

    // Graph Export
    const expPng = document.getElementById('export-png-btn');
    if(expPng) {
        expPng.addEventListener('click', () => {
            if (!currentChart) return;
            const link = document.createElement('a');
            link.download = 'transient_analysis.png';
            link.href = document.getElementById('sim-chart').toDataURL('image/png', 1.0);
            link.click();
        });
    }

    const expCsv = document.getElementById('export-csv-btn');
    if(expCsv) {
        expCsv.addEventListener('click', () => {
            if (!currentChart) return;
            let csv = 'Time(ms),';
            const labels = currentChart.data.datasets.map(d => d.label);
            csv += labels.join(',') + '\\n';
            const times = currentChart.data.labels;
            for (let i = 0; i < times.length; i++) {
                let row = [times[i]];
                for (let ds of currentChart.data.datasets) row.push(ds.data[i]);
                csv += row.join(',') + '\\n';
            }
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = 'transient_analysis.csv';
            link.click();
        });
    }

    // Default Demo Layout (OpAmp Demo with Negative Feedback)
    setTimeout(() => {
        // オペアンプの反転増幅回路 (-1倍)
        addComponent('voltage', 0, 100, 0, '1');            // V1 (入力電圧 1V)
        addComponent('resistor', 100, 100, 0, '1k');        // R2 (入力抵抗 1k)
        addComponent('resistor', 250, 20, 0, '1k');         // R3 (帰還抵抗 1k)
        addComponent('opamp', 250, 115, 0, 'OP1');          // OP4
        addComponent('ground', 0, 200, 0, '0');             // GND5
        addComponent('ground', 180, 200, 0, '0');           // GND6 (非反転入力接地用)
        addComponent('voltmeter', 400, 130, 0, 'Vout');     // Vm7 (出力電圧確認用)

        // 配線 (-1倍増幅なので 出力は -1V になるはず)
        wires.push({ t1:{compId:1, termIdx:0}, t2:{compId:2, termIdx:0} }); // V+ -> Rin
        wires.push({ t1:{compId:2, termIdx:1}, t2:{compId:4, termIdx:0} }); // Rin -> OpAmp(-)
        wires.push({ t1:{compId:2, termIdx:1}, t2:{compId:3, termIdx:0} }); // Rin -> Rfb
        wires.push({ t1:{compId:3, termIdx:1}, t2:{compId:4, termIdx:2} }); // Rfb -> OpAmp(OUT)
        wires.push({ t1:{compId:4, termIdx:1}, t2:{compId:6, termIdx:0} }); // OpAmp(+) -> GND
        wires.push({ t1:{compId:1, termIdx:1}, t2:{compId:5, termIdx:0} }); // V- -> GND
        wires.push({ t1:{compId:4, termIdx:2}, t2:{compId:7, termIdx:0} }); // OpAmp(OUT) -> Vm+
        wires.push({ t1:{compId:7, termIdx:1}, t2:{compId:6, termIdx:0} }); // Vm- -> GND
        renderWires();
    }, 100);

    // --- Phase 10: SPICE Netlist Export ---
    const exportSpiceBtn = document.getElementById('schematic-export-spice-btn');
    if (exportSpiceBtn) {
        exportSpiceBtn.addEventListener('click', () => {
            let parent = {};
            function find(i) {
                if (parent[i] === undefined) parent[i] = i;
                if (parent[i] === i) return i;
                return parent[i] = find(parent[i]);
            }
            function union(i, j) { parent[find(i)] = find(j); }

            wires.forEach(w => {
                const t1 = `${w.t1.compId}_${w.t1.termIdx}`;
                const t2 = `${w.t2.compId}_${w.t2.termIdx}`;
                union(t1, t2);
            });

            let nodeMap = {}; 
            let nextNodeInt = 1;

            components.forEach(c => {
                if (c.type === 'ground') {
                    const tId = `${c.id}_0`;
                    nodeMap[find(tId)] = 0;
                }
            });

            components.forEach(c => {
                c.nodeIds = [];
                c.def.terminals.forEach((t, index) => {
                    const root = find(`${c.id}_${index}`);
                    if (nodeMap[root] === undefined) {
                        nodeMap[root] = nextNodeInt++;
                    }
                    c.nodeIds.push(nodeMap[root]);
                });
            });

            let spiceLines = ["* Web EDA SPICE Export (.cir)", "* " + new Date().toISOString()];
            components.forEach(c => {
                if(c.type === 'text' || c.type === 'ground') return;
                
                let nodes = c.nodeIds.join(' ');
                let val = c.value || "1";
                if(c.type === 'voltmeter' || c.type === 'ammeter') return; // ignore meters
                
                if(c.type === 'opamp') {
                    spiceLines.push(`E_${c.name} ${nodes} 1meg`); // Ideal VCVS
                } else if(c.type === 'switch') {
                    spiceLines.push(`S_${c.name} ${nodes} sw_model`);
                } else {
                    let firstChar = c.type === 'resistor' ? 'R' : c.type === 'voltage' ? 'V' : c.type === 'capacitor' ? 'C' : c.type === 'inductor' ? 'L' : 'X';
                    spiceLines.push(`${c.name} ${nodes} ${val}`);
                }
            });
            spiceLines.push("");
            spiceLines.push(".tran 0.1ms 10ms"); // Default transient analysis parameters
            spiceLines.push(".end");
            
            const blob = new Blob([spiceLines.join('\\n')], {type: "text/plain"});
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = "circuit.cir";
            a.click();
            URL.revokeObjectURL(url);
        });
    }

});
