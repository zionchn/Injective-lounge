(function () {
    const CHAIN_ID = "injective-1";
    const btn = document.getElementById("connectBtn");
    const disconnectBtn = document.getElementById("disconnectBtn");
    const input = document.getElementById("walletAddress");
    const statusEl = document.getElementById("walletStatus");
    const choicesEl = document.getElementById("walletChoices");

    if (!btn || !input || !statusEl) return;

    /* ---------- 0x -> inj1 (bech32) ---------- */
    const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

    function polymod(values) {
        const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
        let chk = 1;
        for (const v of values) {
            const top = chk >>> 25;
            chk = ((chk & 0x1ffffff) << 5) ^ v;
            for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
        }
        return chk >>> 0;
    }
    function hrpExpand(hrp) {
        const out = [];
        for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
        out.push(0);
        for (const c of hrp) out.push(c.charCodeAt(0) & 31);
        return out;
    }
    function toFiveBitGroups(bytes) {
        let acc = 0, bits = 0;
        const out = [];
        for (const b of bytes) {
            acc = ((acc << 8) | b) & 0xfff;
            bits += 8;
            while (bits >= 5) { bits -= 5; out.push((acc >> bits) & 31); }
        }
        if (bits > 0) out.push((acc << (5 - bits)) & 31);
        return out;
    }
    function bech32Encode(hrp, bytes) {
        const data = toFiveBitGroups(bytes);
        const mod = polymod(hrpExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0])) ^ 1;
        const checksum = [];
        for (let i = 0; i < 6; i++) checksum.push((mod >> (5 * (5 - i))) & 31);
        return hrp + "1" + data.concat(checksum).map(d => CHARSET[d]).join("");
    }
    function hexToInj(hex) {
        const bytes = hex.replace(/^0x/i, "").match(/.{2}/g).map(h => parseInt(h, 16));
        return bech32Encode("inj", bytes);
    }

    /* ---------- wallet connectors ---------- */
    function getMetaMask() {
        const eth = window.ethereum;
        if (!eth) return null;
        if (eth.providers?.length) {
            return eth.providers.find(p => p.isMetaMask && !p.isRabby && !p.isKeplr) || null;
        }
        return eth.isMetaMask && !eth.isKeplr && !eth.isRabby ? eth : null;
    }

    async function connectMetaMask(provider) {
        // Always show MetaMask's account picker
        try {
            await provider.request({
                method: "wallet_requestPermissions",
                params: [{ eth_accounts: {} }],
            });
        } catch (e) {
            if (e.code === 4001) throw e;   // user rejected
        }
        const accounts = await provider.request({ method: "eth_requestAccounts" });
        return hexToInj(accounts[0]);
    }

    async function connectCosmos(wallet) {
        await wallet.enable(CHAIN_ID);
        const { bech32Address } = await wallet.getKey(CHAIN_ID);
    
        // Signing always shows a popup, even if the site was approved before.
        // It costs no gas and sends no transaction.
        await wallet.signArbitrary(
            CHAIN_ID,
            bech32Address,
            "Connect to Injective Lounge\n\n" + new Date().toISOString()
        );
    
        return bech32Address;
    }

    function detectWallets() {
        const list = [];
        const mm = getMetaMask();
        if (mm) list.push({ name: "MetaMask", connect: () => connectMetaMask(mm) });
        if (window.keplr) list.push({ name: "Keplr", connect: () => connectCosmos(window.keplr) });
        return list;
    }

    /* ---------- UI ---------- */
    function setStatus(message, isError) {
        statusEl.textContent = message;
        statusEl.className = "small mb-3 " + (isError ? "text-danger" : "text-success");
    }

    function clearConnection(message) {
        input.value = "";
        setStatus(message || "", false);
    }

    function hideChoices() {
        if (!choicesEl) return;
        choicesEl.hidden = true;
        choicesEl.innerHTML = "";
    }

    async function connectWith(wallet) {
        hideChoices();
        const label = btn.textContent;
        btn.disabled = true;
        btn.textContent = "Connecting...";
        setStatus("", false);
        try {
            const address = await wallet.connect();
            if (!/^inj1[a-z0-9]{38}$/.test(address)) {
                throw new Error("Unexpected address format: " + address);
            }
            input.value = address;
            setStatus("Connected with " + wallet.name + ": " + address.slice(0, 8) + "..." + address.slice(-6), false);
        } catch (err) {
            const rejected = err.code === 4001 || /reject|denied|declined/i.test(err.message || "");
            setStatus(rejected ? "Connection cancelled." : (err.message || "Could not connect."), true);
        } finally {
            btn.disabled = false;
            btn.textContent = label;
        }
    }

    btn.addEventListener("click", () => {
        const wallets = detectWallets();

        if (wallets.length === 0) {
            setStatus("No wallet found. Install MetaMask or Keplr, or paste your address below.", true);
            return;
        }
        if (wallets.length === 1) {
            connectWith(wallets[0]);
            return;
        }

        // Several wallets installed: let the user choose
        setStatus("", false);
        if (!choicesEl) {
            connectWith(wallets[0]);
            return;
        }
        choicesEl.innerHTML = "";
        wallets.forEach((w) => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "btn btn-pill w-100";
            b.textContent = w.name;
            b.addEventListener("click", () => connectWith(w));
            choicesEl.appendChild(b);
        });
        choicesEl.hidden = false;
    });

    /* ---------- disconnect ---------- */
    disconnectBtn?.addEventListener("click", async () => {
        hideChoices();
        const mm = getMetaMask();
        if (mm) {
            try {
                await mm.request({
                    method: "wallet_revokePermissions",
                    params: [{ eth_accounts: {} }],
                });
            } catch (e) { /* not supported on some versions; the page still disconnects below */ }
        }
        clearConnection("Disconnected. Keplr can only be removed from inside the extension.");
    });

    // Follow MetaMask if the user disconnects or switches account inside it
    getMetaMask()?.on?.("accountsChanged", (accounts) => {
        if (!accounts.length) clearConnection("Wallet disconnected.");
        else if (input.value.startsWith("inj1")) {
            input.value = hexToInj(accounts[0]);
            setStatus("Account changed.", false);
        }
    });
})();