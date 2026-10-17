(function () {
    const CHAIN_ID = "injective-1";
    const btn = document.getElementById("connectBtn");
    const input = document.getElementById("walletAddress");
    const statusEl = document.getElementById("walletStatus");

    /* ---------- bech32 encoder (for 0x -> inj1) ---------- */
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
        const maxAcc = (1 << 12) - 1;
        for (const b of bytes) {
            acc = ((acc << 8) | b) & maxAcc;
            bits += 8;
            while (bits >= 5) {
                bits -= 5;
                out.push((acc >> bits) & 31);
            }
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
        const clean = hex.replace(/^0x/i, "");
        const bytes = clean.match(/.{2}/g).map(h => parseInt(h, 16));
        return bech32Encode("inj", bytes);
    }

    /* ---------- wallet connectors ---------- */
    async function viaCosmosWallet(wallet) {
        await wallet.enable(CHAIN_ID);
        const key = await wallet.getKey(CHAIN_ID);
        return key.bech32Address;
    }

    async function viaMetaMask() {
        const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
        return hexToInj(accounts[0]);
    }

    async function getInjAddress() {
        if (window.keplr) return viaCosmosWallet(window.keplr);
        if (window.leap) return viaCosmosWallet(window.leap);
        if (window.ethereum) return viaMetaMask();
        throw new Error("No wallet found. Install Keplr, Leap, or MetaMask, or paste your address below.");
    }

    /* ---------- UI ---------- */
    function setStatus(message, isError) {
        statusEl.textContent = message;
        statusEl.className = "small mb-3 " + (isError ? "text-danger" : "text-success");
    }

    btn.addEventListener("click", async () => {
        const originalLabel = btn.textContent;
        btn.disabled = true;
        btn.textContent = "Connecting...";
        setStatus("", false);

        try {
            const address = await getInjAddress();
            if (!/^inj1[a-z0-9]{38}$/.test(address)) {
                throw new Error("Got an unexpected address format: " + address);
            }
            input.value = address;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            setStatus("Connected: " + address.slice(0, 8) + "..." + address.slice(-6), false);
        } catch (err) {
            const rejected = /reject|denied|declined/i.test(err.message || "");
            setStatus(rejected ? "Connection request was cancelled." : (err.message || "Could not connect wallet."), true);
        } finally {
            btn.disabled = false;
            btn.textContent = originalLabel;
        }
    });
})();