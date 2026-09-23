(() => {
  const SCRIPTS = [
    { code: 'ja-JP', pattern: /[぀-ヿ]/g },
    { code: 'cmn-Hans-CN', pattern: /[一-鿿]/g },
    { code: 'ko-KR', pattern: /[가-힯ᄀ-ᇿ]/g },
    { code: 'th-TH', pattern: /[฀-๿]/g },
    { code: 'ar-EG', pattern: /[؀-ۿ]/g },
    { code: 'ru-RU', pattern: /[Ѐ-ӿ]/g },
    { code: 'hi-IN', pattern: /[ऀ-ॿ]/g },
    { code: 'he-IL', pattern: /[֐-׿]/g },
    { code: 'el-GR', pattern: /[Ͱ-Ͽ]/g },
  ]

  const words = (list) => new Set(list.split(' '))
  const LATIN = [
    {
      code: 'id-ID',
      stop: words('yang dan di ini itu dengan untuk tidak ada dari ke akan juga sudah saya kita kami kamu aku gue lu dia mereka bisa karena jadi atau pada dalam lagi apa kalau kalo nya ya nggak gak enggak sih kok dong deh aja udah belum masih bukan harus mau banget sama buat terus tapi tetapi lebih sangat seperti bahwa oleh adalah tersebut hal agar namun saat setelah sebelum kemudian semua sebuah satu dua tiga'),
      marks: [/(?:kan|nya|lah|kah)\b/g, /\b(?:me|ber|di|ter|pe)[a-z]{3,}/g, /ng|ny/g],
    },
    {
      code: 'en-US',
      stop: words('the and to of a in is it you that he was for on are with as i his they be at one have this from or had by but not what all were we when your can said there use an each which she do how their if will up other about out many then them these so some her would make like him into time has look two more write go see no way could people my than first been who its now find long down day did get come made may part yeah okay just really think know going'),
      marks: [/th|wh/g, /ing\b|tion\b|ly\b/g],
    },
    {
      code: 'es-ES',
      stop: words('el la de que y en un una los las del se por con no para es lo como más pero sus le ya o este sí porque esta entre cuando muy sin sobre también me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos esto mí antes algunos qué unos yo otro otras otra él tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros'),
      marks: [/ñ|ción\b|[áéíóú]/g],
    },
    {
      code: 'pt-BR',
      stop: words('o a de que e do da em um para é com não uma os no se na por mais as dos como mas foi ao ele das tem à seu sua ou ser quando muito há nos já está eu também só pelo pela até isso ela entre era depois sem mesmo aos ter seus quem nas me esse eles estão você tinha foram essa num nem suas meu às minha têm numa pelos elas havia seja qual será nós tenho lhe deles essas esses pelas este fosse dele tu te vocês vos lhes'),
      marks: [/ção\b|ções\b|[ãõç]/g],
    },
    {
      code: 'fr-FR',
      stop: words('le la les de des du un une et est en que qui dans pour pas sur au aux avec ce ces il elle nous vous ils elles je tu on mais ou où donc car ne se sa son ses leur leurs mon ma mes ton ta tes notre votre plus très bien aussi être avoir fait comme tout tous cette cet'),
      marks: [/[éèêàçùœ]|eau|aux\b/g],
    },
    {
      code: 'de-DE',
      stop: words('der die das und ist in zu den von mit sich des auf für nicht ein eine als auch es an werden aus er hat dass sie nach wird bei einer um am sind noch wie einem über einen so zum war haben nur oder aber vor zur bis mehr durch man sein wurde sei ich du wir ihr'),
      marks: [/[äöüß]|sch|ung\b|keit\b/g],
    },
    {
      code: 'it-IT',
      stop: words('il di che e la in un una per non sono è le si con da del della lo gli al come ma anche più se ci questo questa quando molto perché mi ti noi voi loro io tu lui lei ho hai ha abbiamo avete hanno essere stato'),
      marks: [/zione\b|gli|[àèìòù]/g],
    },
    {
      code: 'nl-NL',
      stop: words('de het een en van in is dat op te zijn voor met die niet aan er maar om ook als bij dan nog wel naar kan uit wat hij zij wij ik jij u deze dit geen worden werd heeft hebben'),
      marks: [/ij|oe|aa|ee\b/g],
    },
    {
      code: 'vi-VN',
      stop: words('và của là có không được cho một những này trong người với các để đã khi thì cũng như từ đến tôi bạn chúng ta anh chị em'),
      marks: [/[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/g],
    },
  ]

  const SAMPLES = {
    'id-ID': 'Pagi itu kami berangkat bersama menuju kantor untuk mengikuti rapat mingguan. Setiap orang menyampaikan perkembangan pekerjaan masing masing dan menjelaskan kendala yang sedang dihadapi. Anak anak bermain di halaman sekolah sambil menunggu orang tua mereka datang menjemput. Pemerintah daerah berencana membangun jalan baru agar perjalanan warga menjadi lebih cepat dan nyaman. Saya belum sempat membaca laporan itu karena seharian harus menyelesaikan tugas yang lain. Kalau kamu ada waktu nanti sore, tolong kirimkan catatan pertemuan kemarin ke semua peserta. Hujan turun sangat deras sehingga banyak kendaraan berhenti di pinggir jalan. Mereka membawa makanan, minuman, dan perlengkapan lain untuk perjalanan panjang ke desa.',
    'en-US': 'This morning we walked together to the office to join the weekly meeting. Everyone shared an update about their work and explained the problems they were facing. The children played in the school yard while waiting for their parents to pick them up. The city council plans to build a new road so that people can travel faster and more comfortably. I have not had time to read that report because I spent the whole day finishing other tasks. If you have some time this afternoon, please send the notes from yesterday to everyone. It was raining so heavily that many cars stopped by the side of the road. They brought food, drinks, and other supplies for the long journey to the village.',
    'es-ES': 'Esta mañana caminamos juntos hasta la oficina para participar en la reunión semanal. Cada persona compartió los avances de su trabajo y explicó los problemas que estaba enfrentando. Los niños jugaban en el patio de la escuela mientras esperaban a que sus padres vinieran a buscarlos. El ayuntamiento planea construir una nueva carretera para que la gente pueda viajar más rápido y cómoda. Todavía no he tenido tiempo de leer ese informe porque pasé todo el día terminando otras tareas. Si tienes tiempo esta tarde, por favor envía las notas de ayer a todos los participantes. Llovía tanto que muchos coches se detuvieron al lado del camino.',
    'pt-BR': 'Hoje de manhã caminhamos juntos até o escritório para participar da reunião semanal. Cada pessoa compartilhou o andamento do seu trabalho e explicou os problemas que estava enfrentando. As crianças brincavam no pátio da escola enquanto esperavam os pais chegarem para buscá las. A prefeitura planeja construir uma nova estrada para que as pessoas possam viajar mais rápido e com conforto. Ainda não tive tempo de ler aquele relatório porque passei o dia inteiro terminando outras tarefas. Se você tiver tempo hoje à tarde, por favor envie as anotações de ontem para todos. Chovia tanto que muitos carros pararam na beira da estrada.',
    'fr-FR': 'Ce matin nous avons marché ensemble jusqu au bureau pour participer à la réunion hebdomadaire. Chaque personne a présenté l avancement de son travail et a expliqué les difficultés rencontrées. Les enfants jouaient dans la cour de l école en attendant que leurs parents viennent les chercher. La mairie prévoit de construire une nouvelle route afin que les habitants puissent voyager plus vite et plus confortablement. Je n ai pas encore eu le temps de lire ce rapport parce que j ai passé toute la journée à terminer d autres tâches. Si tu as du temps cet après midi, envoie les notes d hier à tout le monde. Il pleuvait tellement que beaucoup de voitures se sont arrêtées au bord de la route.',
    'de-DE': 'Heute Morgen sind wir zusammen ins Büro gegangen, um an der wöchentlichen Besprechung teilzunehmen. Jede Person hat über den Stand ihrer Arbeit berichtet und die Probleme erklärt, mit denen sie gerade kämpft. Die Kinder spielten auf dem Schulhof, während sie darauf warteten, dass ihre Eltern sie abholen. Die Stadt plant, eine neue Straße zu bauen, damit die Menschen schneller und bequemer reisen können. Ich hatte noch keine Zeit, diesen Bericht zu lesen, weil ich den ganzen Tag andere Aufgaben erledigen musste. Wenn du heute Nachmittag Zeit hast, schick bitte die Notizen von gestern an alle. Es regnete so stark, dass viele Autos am Straßenrand anhielten.',
    'it-IT': 'Stamattina siamo andati insieme in ufficio per partecipare alla riunione settimanale. Ogni persona ha raccontato i progressi del proprio lavoro e ha spiegato i problemi che stava affrontando. I bambini giocavano nel cortile della scuola mentre aspettavano che i genitori venissero a prenderli. Il comune ha intenzione di costruire una nuova strada perché le persone possano viaggiare più velocemente e comodamente. Non ho ancora avuto tempo di leggere quella relazione perché ho passato tutta la giornata a finire altri compiti. Se hai tempo questo pomeriggio, per favore manda gli appunti di ieri a tutti. Pioveva così forte che molte macchine si sono fermate sul bordo della strada.',
    'nl-NL': 'Vanochtend liepen we samen naar het kantoor om deel te nemen aan de wekelijkse vergadering. Iedereen vertelde hoe het met zijn werk ging en legde uit tegen welke problemen hij aanliep. De kinderen speelden op het schoolplein terwijl ze wachtten tot hun ouders hen kwamen ophalen. De gemeente wil een nieuwe weg aanleggen zodat mensen sneller en comfortabeler kunnen reizen. Ik heb nog geen tijd gehad om dat verslag te lezen omdat ik de hele dag andere taken moest afmaken. Als je vanmiddag tijd hebt, stuur dan alsjeblieft de aantekeningen van gisteren naar iedereen. Het regende zo hard dat veel auto s langs de kant van de weg stopten.',
    'vi-VN': 'Sáng nay chúng tôi cùng nhau đi bộ đến văn phòng để tham dự cuộc họp hằng tuần. Mỗi người chia sẻ tiến độ công việc của mình và giải thích những khó khăn đang gặp phải. Những đứa trẻ chơi đùa trong sân trường trong khi chờ bố mẹ đến đón. Chính quyền thành phố dự định xây một con đường mới để người dân đi lại nhanh hơn và thoải mái hơn. Tôi vẫn chưa có thời gian đọc báo cáo đó vì cả ngày phải hoàn thành những việc khác. Nếu chiều nay bạn có thời gian, hãy gửi ghi chú của hôm qua cho mọi người.',
  }

  function trigrams(text) {
    const counts = new Map()
    for (const word of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
      const padded = ` ${word} `
      for (let i = 0; i < padded.length - 2; i++) {
        const gram = padded.slice(i, i + 3)
        counts.set(gram, (counts.get(gram) ?? 0) + 1)
      }
    }
    return counts
  }

  function norm(counts) {
    let sum = 0
    for (const value of counts.values()) sum += value * value
    return Math.sqrt(sum)
  }

  const PROFILES = new Map(Object.entries(SAMPLES).map(([code, sample]) => {
    const counts = trigrams(sample)
    return [code, { counts, norm: norm(counts) }]
  }))

  function cosine(counts, profile) {
    let dot = 0
    for (const [gram, value] of counts) dot += value * (profile.counts.get(gram) ?? 0)
    const size = norm(counts)
    return size && profile.norm ? dot / (size * profile.norm) : 0
  }

  const LETTER = /\p{L}/gu
  const MIN_SHAPE = 0.16
  const CONFIDENCE_SCALE = 2.5

  function count(text, pattern) {
    pattern.lastIndex = 0
    return (text.match(pattern) ?? []).length
  }

  function detect(raw) {
    const text = String(raw ?? '').normalize('NFC')
    const letters = count(text, LETTER)
    if (!letters) return null
    for (const script of SCRIPTS) {
      const hits = count(text, script.pattern)
      if (hits / letters >= 0.3) {
        return { code: script.code, confidence: Math.min(0.99, 0.7 + hits / letters * 0.3), tokens: hits, letters, script: true }
      }
    }
    const lower = text.toLowerCase()
    const tokens = lower.match(/\p{L}+/gu) ?? []
    if (!tokens.length) return null
    const grams = trigrams(lower)
    const scores = LATIN.map((profile) => {
      let stop = 0
      for (const token of tokens) if (profile.stop.has(token)) stop++
      let marks = 0
      for (const pattern of profile.marks) marks += count(lower, pattern)
      const shape = PROFILES.has(profile.code) ? cosine(grams, PROFILES.get(profile.code)) : 0
      const score = shape + stop / tokens.length * 0.6 + Math.min(0.2, marks / Math.max(1, tokens.length) * 0.1)
      return { code: profile.code, score, shape }
    }).sort((a, b) => b.score - a.score)
    const [best, second] = scores
    if (!best || best.shape < MIN_SHAPE) return { code: null, confidence: 0, tokens: tokens.length, letters, script: false }
    const margin = best.score - (second?.score ?? 0)
    const confidence = Math.max(0, Math.min(0.99, margin / best.score * CONFIDENCE_SCALE))
    return { code: best.code, confidence, tokens: tokens.length, letters, script: false }
  }

  const SUPPORTED = Object.freeze([...LATIN.map((profile) => profile.code), ...SCRIPTS.map((script) => script.code)])

  globalThis.RekapinLanguage = Object.freeze({ detect, supported: SUPPORTED })
})()
