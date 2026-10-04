// ========================================================
// FUNÇÃO CENTRAL DO HALL DA FAMA (CORRIGIDA ANTI-DUPLICAÇÃO)
// ========================================================
async function processHallOfFame(rankString) {
  if (!rankString || rankString.length <= 5 || rankString.includes("Waiting")) return;
  try {
    let hofRes = await db.query("SELECT value FROM kvstore WHERE id=$1", ["HALL_OF_FAME"]);
    let hofList = [];
    if (hofRes.rowCount > 0 && hofRes.rows[0].value) { 
      try { hofList = JSON.parse(hofRes.rows[0].value); } catch(e){} 
    }
    
    // 1. Usamos um Map para garantir UNICIDADE ABSOLUTA por nome (ignorando maiúsculas e minúsculas)
    let playerRecords = new Map();
    
    // 2. Carrega os jogadores que já estão no HoF para o Map (isso já limpa duplicatas antigas do DB)
    hofList.forEach(p => {
      if (p && p.name) {
        let cleanName = p.name.trim().toLowerCase();
        // Se o jogador não está no Map, ou a pontuação salva for maior, atualiza
        if (!playerRecords.has(cleanName) || playerRecords.get(cleanName).score < p.score) {
          playerRecords.set(cleanName, { name: p.name.trim(), score: p.score });
        }
      }
    });
    
    const lines = rankString.split(/\\n|\n/);
    
    // 3. Processa a nova string de ranking da semana
    lines.forEach(line => {
       let match = line.match(/(?:[\d]+[°\.]\s*:?\s*)?(.+?)\s*(?:\(([\d,\.]+)\)|-\s*([\d,\.]+))/);
       if (match) {
         let playerName = match[1].trim();
         let cleanName = playerName.toLowerCase(); // Chave limpa e padronizada
         let scoreStr = match[2] || match[3];
         let weeklyScore = parseInt(scoreStr.replace(/\D/g, ''));
         
         if (!isNaN(weeklyScore)) {
           if (playerRecords.has(cleanName)) {
             let existing = playerRecords.get(cleanName);
             // Atualiza apenas se o recorde DESTA semana for MAIOR que o recorde HISTÓRICO
             if (weeklyScore > existing.score) {
               existing.score = weeklyScore;
               existing.name = playerName; // Atualiza a formatação do nome pro mais recente
             }
           } else {
             // Jogador novo entrando no Hall of Fame
             playerRecords.set(cleanName, { name: playerName, score: weeklyScore });
           }
         }
       }
    });
    
    // 4. Converte o Map de volta para Array, ordena do maior pro menor e pega os top 3
    hofList = Array.from(playerRecords.values());
    hofList.sort((a, b) => b.score - a.score);
    hofList = hofList.slice(0, 3);
    
    // 5. Salva no banco de dados
    await db.query(`INSERT INTO kvstore (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`, ["HALL_OF_FAME", JSON.stringify(hofList)]);
  } catch(e) {
    console.error("Erro ao processar Hall of Fame:", e);
  }
}
