import 'dotenv/config';

async function checkModels() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.log("エラー：.envにAPIキーが見つかりません。");
        return;
    }
    
    console.log("Geminiサーバーに直接モデル一覧を問い合わせ中...");
    
    try {
        // SDKを使わず、直接URLを叩いてデータをもらいます
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        const data = await response.json();
        
        if (data.models) {
            console.log("\n【現在あなたのAPIキーで使用可能なモデル一覧】");
            data.models.forEach(m => {
                // flash か pro という名前がつくモデルだけ抽出します
                if (m.name.includes("flash") || m.name.includes("pro")) {
                    console.log("・", m.name);
                }
            });
        } else {
            console.log("\nAPIエラーが発生しました:", data);
        }
    } catch (e) {
        console.error("通信エラー:", e);
    }
}

checkModels();