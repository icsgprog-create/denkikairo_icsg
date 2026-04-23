from fastapi import FastAPI, HTTPException, Header
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from typing import List, Dict, Any, Optional
import math
import numpy as np
import sqlite3
import hashlib
import secrets
import logging
from datetime import datetime, timedelta

app = FastAPI(title="総合電気回路計算Webアプリケーション API")
logger = logging.getLogger(__name__)

DB_FILE = "circuits_v2.db"

def init_db():
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT)''')
    c.execute('''CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER, expires_at DATETIME)''')
    c.execute('''CREATE TABLE IF NOT EXISTS circuits (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, json_data TEXT)''')
    conn.commit()
    conn.close()

init_db()

def hash_pw(password: str, salt: bytes = None) -> str:
    if not salt:
        salt = secrets.token_bytes(16)
    key = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, 100000)
    return salt.hex() + ":" + key.hex()

def verify_pw(password: str, hashed_str: str) -> bool:
    try:
        salt_hex, key_hex = hashed_str.split(':')
        salt = bytes.fromhex(salt_hex)
        return hash_pw(password, salt) == hashed_str
    except (ValueError, TypeError, AttributeError):
        logger.warning("Invalid password hash format during verification")
        return False

def get_current_user(authorization: str = Header(None)):
    if not authorization or not authorization.startswith("Bearer "): return None
    token = authorization.split(" ")[1]
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT users.id, users.username, sessions.expires_at FROM sessions JOIN users ON sessions.user_id = users.id WHERE token=?", (token,))
    row = c.fetchone()
    if row:
        expires_at = datetime.fromisoformat(row[2])
        if datetime.now() > expires_at:
            c.execute("DELETE FROM sessions WHERE token=?", (token,))
            conn.commit()
            conn.close()
            return None
        conn.close()
        return {"id": row[0], "username": row[1]}
    conn.close()
    return None

class UserCreate(BaseModel):
    username: str = Field(..., min_length=3, max_length=20, pattern="^[a-zA-Z0-9_]+$")
    password: str = Field(..., min_length=8)

class CircuitSave(BaseModel):
    name: str = Field(..., min_length=1, max_length=50)
    json_data: str

@app.post("/api/register")
def register(user: UserCreate):
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    try:
        c.execute("INSERT INTO users (username, password_hash) VALUES (?, ?)", (user.username, hash_pw(user.password)))
        conn.commit()
        return {"msg": "Success"}
    except sqlite3.IntegrityError:
        conn.close()
        raise HTTPException(status_code=400, detail="Username already exists")
    finally:
        conn.close()

@app.post("/api/login")
def login(user: UserCreate):
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT id, password_hash FROM users WHERE username=?", (user.username,))
    row = c.fetchone()
    if not row or not verify_pw(user.password, row[1]):
        conn.close()
        raise HTTPException(status_code=401, detail="無効な認証情報です")
    token = secrets.token_hex(16)
    expires_at = (datetime.now() + timedelta(days=1)).isoformat()
    c.execute("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)", (token, row[0], expires_at))
    conn.commit()
    conn.close()
    return {"token": token, "username": user.username}

@app.get("/api/me")
def me(authorization: str = Header(None)):
    user = get_current_user(authorization)
    if not user: raise HTTPException(status_code=401)
    return user

@app.post("/api/circuits")
def save_circuit(data: CircuitSave, authorization: str = Header(None)):
    user = get_current_user(authorization)
    if not user: raise HTTPException(status_code=401)
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("INSERT INTO circuits (user_id, name, json_data) VALUES (?, ?, ?)", (user["id"], data.name, data.json_data))
    conn.commit()
    conn.close()
    return {"msg": "Saved"}

@app.get("/api/circuits")
def list_circuits(authorization: str = Header(None)):
    user = get_current_user(authorization)
    if not user: raise HTTPException(status_code=401)
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT id, name, json_data FROM circuits WHERE user_id=? ORDER BY id DESC", (user["id"],))
    rows = c.fetchall()
    conn.close()
    return [{"id": r[0], "name": r[1], "json_data": r[2]} for r in rows]

@app.delete("/api/circuits/{cid}")
def delete_circuit(cid: int, authorization: str = Header(None)):
    user = get_current_user(authorization)
    if not user: raise HTTPException(status_code=401)
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("DELETE FROM circuits WHERE id=? AND user_id=?", (cid, user["id"]))
    conn.commit()
    conn.close()
    return {"msg": "Deleted"}

class AdvancedCircuitRequest(BaseModel):
    netlist: List[Dict[str, Any]]

@app.post("/api/v1/solve-advanced")
async def solve_advanced_circuit(req: AdvancedCircuitRequest):
    """
    大学レベルの回路解析（MNA: 修正節点解析法 + 後退オイラー過渡解析）を行うエンドポイント
    """
    netlist = req.netlist
    
    is_transient = any(c.get('type') in ['capacitor', 'inductor'] for c in netlist)
    
    dt = 1e-4  # 0.1ms (サンプリング間隔)
    total_time = 0.01  # 10ms (観測時間)
    steps = int(total_time / dt) if is_transient else 1
    
    max_node = 0
    voltage_sources = []
    
    for comp in netlist:
        nodes = comp.get('nodes', [])
        for n in nodes:
            if int(n) > max_node:
                max_node = int(n)
        if comp.get('type') in ['voltage', 'opamp']:
            voltage_sources.append(comp)
            
    num_nodes = max_node
    num_vsources = len(voltage_sources)
    matrix_size = num_nodes + num_vsources
    
    if matrix_size == 0:
        return {"status": "success", "node_voltages": {}, "components": {}}

    transient_data = {
        "time": [],
        "nodes": {i: [] for i in range(1, num_nodes + 1)}
    }
    
    results = {}
    node_voltages = {0: 0.0}
    state = {c['name']: 0.0 for c in netlist if c.get('type') in ['capacitor', 'inductor']}

    for step in range(steps):
        A = np.zeros((matrix_size, matrix_size))
        Z = np.zeros((matrix_size, 1))
        
        v_idx = 0
        for comp in netlist:
            c_type = comp.get('type')
            nodes = comp.get('nodes', [])
            if len(nodes) < 2: continue
            n1, n2 = map(int, nodes[:2])
            
            raw_val = comp.get('value', '0').replace('k', 'e3').replace('u', 'e-6').replace('m', 'e-3')
            
            current_eq = 0.0
            if c_type == 'ammeter':
                val = 1e-9
            elif c_type == 'voltmeter':
                val = 1e9
            elif c_type == 'capacitor':
                try:
                    C = float(raw_val)
                except (ValueError, TypeError):
                    C = 1e-6
                val = dt / C if C > 0 else 1e9
                current_eq = (C / dt) * state.get(comp['name'], 0.0)
            elif c_type == 'inductor':
                try:
                    L = float(raw_val)
                except (ValueError, TypeError):
                    L = 1e-3
                val = L / dt if dt > 0 else 1e-9
                current_eq = -state.get(comp['name'], 0.0)
            elif c_type == 'switch':
                try:
                    t_on = float(raw_val) * 1e-3
                except (ValueError, TypeError):
                    t_on = 0.0
                t_current = step * dt
                val = 1e-3 if t_current >= t_on else 1e9
            else:
                try:
                    val = float(raw_val)
                except (ValueError, TypeError):
                    continue

            if c_type in ['resistor', 'ammeter', 'voltmeter', 'capacitor', 'inductor', 'switch']:
                if val == 0: val = 1e-9
                g = 1.0 / val
                
                if n1 > 0: 
                    A[n1-1, n1-1] += g
                    Z[n1-1, 0] += current_eq
                if n2 > 0: 
                    A[n2-1, n2-1] += g
                    Z[n2-1, 0] -= current_eq
                if n1 > 0 and n2 > 0:
                    A[n1-1, n2-1] -= g
                    A[n2-1, n1-1] -= g

            elif c_type == 'voltage':
                vs_idx = num_nodes + v_idx
                if n1 > 0:
                    A[n1-1, vs_idx] += 1
                    A[vs_idx, n1-1] += 1
                if n2 > 0:
                    A[n2-1, vs_idx] -= 1
                    A[vs_idx, n2-1] -= 1
                try:
                    v_val = float(raw_val)
                except (ValueError, TypeError):
                    v_val = 0.0
                Z[vs_idx, 0] = v_val
                comp['v_idx'] = vs_idx
                v_idx += 1
                
            elif c_type == 'opamp':
                if len(nodes) < 3: continue
                n3 = int(nodes[2])
                vs_idx = num_nodes + v_idx
                if n3 > 0:
                    A[n3-1, vs_idx] += 1
                gain = 1e5
                if n2 > 0: A[vs_idx, n2-1] += 1
                if n1 > 0: A[vs_idx, n1-1] -= 1
                if n3 > 0: A[vs_idx, n3-1] -= 1.0 / gain
                
                Z[vs_idx, 0] = 0.0
                comp['v_idx'] = vs_idx
                v_idx += 1
                
        try:
            x = np.linalg.solve(A, Z)
        except np.linalg.LinAlgError:
             return {"status": "error", "message": "回路方程式が解けません。未接続ノードや電源同士の矛盾がないか確認してください。"}
             
        for i in range(num_nodes):
            v_node = float(x[i, 0])
            node_voltages[i+1] = v_node
            if is_transient:
                transient_data["nodes"][i+1].append(round(v_node, 6))
                
        if is_transient:
            transient_data["time"].append(round(step * dt, 5))
            
        for comp in netlist:
            c_type = comp.get('type')
            nodes = comp.get('nodes', [])
            if len(nodes) < 2: continue
            n1, n2 = map(int, nodes[:2])
            v_drop = node_voltages.get(n1, 0.0) - node_voltages.get(n2, 0.0)
            
            if c_type == 'capacitor':
                state[comp['name']] = v_drop
            elif c_type == 'inductor':
                try:
                    L = float(comp.get('value', '1e-3').replace('m', 'e-3'))
                except (ValueError, TypeError, AttributeError):
                    L = 1e-3
                state[comp['name']] = state.get(comp['name'], 0.0) + (dt / L) * v_drop
                
        if step == steps - 1:
            for comp in netlist:
                c_type = comp.get('type')
                nodes = comp.get('nodes', [])
                if len(nodes) < 2: continue
                n1, n2 = map(int, nodes[:2])
                v1 = node_voltages.get(n1, 0.0)
                v2 = node_voltages.get(n2, 0.0)
                v_drop = v1 - v2
                
                current = 0.0
                if c_type in ['resistor', 'ammeter', 'voltmeter', 'capacitor', 'inductor']:
                    if c_type == 'capacitor':
                        try:
                            C = float(comp.get('value', '1u').replace('u', 'e-6'))
                        except (ValueError, TypeError, AttributeError):
                            C = 1e-6
                        current = C * (v_drop - state.get(comp['name'], 0.0)) / dt if steps>1 else 0.0
                    elif c_type == 'inductor':
                        current = state.get(comp['name'], 0.0)
                    else:
                        sim_val = 1e-9 if c_type == 'ammeter' else (1e9 if c_type == 'voltmeter' else 1.0)
                        raw_val = comp.get('value', str(sim_val)).replace('k', 'e3')
                        try:
                            current = v_drop / float(raw_val)
                        except (ValueError, TypeError):
                            current = v_drop / sim_val
                elif c_type in ['voltage', 'opamp']:
                    if 'v_idx' in comp:
                        current = float(x[comp['v_idx'], 0])
                    else:
                        current = 0.0
                    
                results[comp['name']] = {
                    "v_drop": round(v_drop, 6),
                    "current": round(current, 6),
                    "v1": round(v1, 6),
                    "v2": round(v2, 6)
                }

    res_obj = {
        "status": "success",
        "node_voltages": {k: round(v, 6) for k, v in node_voltages.items()},
        "components": results
    }
    if is_transient:
        res_obj["transient_data"] = transient_data
        
    return res_obj


# --- 現在の簡易的なバックエンド計算モデル（必要に応じた通信例） ---
class RLCRequest(BaseModel):
    R: float
    L: float
    C: float
    frequency: float

@app.post("/api/v1/calc-rlc")
async def calculate_rlc(req: RLCRequest):
    """
    計算が複雑化した場合のために、意図的にサーバーで計算させるAPI例。
    今回UIはJS側でリアルタイム計算しますが、このAPIも利用可能です。
    """
    if req.frequency <= 0:
        raise HTTPException(status_code=400, detail="Frequency must be strictly positive.")
    
    omega = 2 * math.pi * req.frequency
    x_l = omega * req.L
    x_c = 1 / (omega * req.C) if req.C != 0 else float('inf')
    
    x_total = x_l - x_c
    z_mag = math.sqrt(req.R**2 + x_total**2)
    
    phase_rad = math.atan2(x_total, req.R)
    phase_deg = math.degrees(phase_rad)
    
    f_res = 1 / (2 * math.pi * math.sqrt(req.L * req.C)) if req.L > 0 and req.C > 0 else 0
    
    return {
        "Z_magnitude": z_mag,
        "phase_degree": phase_deg,
        "resonance_frequency": f_res
    }

# 静的ファイルの配信（フロントエンドのホスティング）
# "/static" 以下にアクセスが来たら静的ファイルを返す
app.mount("/", StaticFiles(directory="static", html=True), name="static")
