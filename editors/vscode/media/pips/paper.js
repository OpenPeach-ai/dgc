/* Paper pals: little articulated cut-paper characters. No assets, canvas, or shaders. */
(() => {
  'use strict';
  const names = ['Core','Scout','Lens','Patch','Rook','Pulse','Lock','Quill'];
  const palettes = [
    ['#AE91E3','#DDD0F2','#74569E'], ['#72B699','#CEE4D2','#427E68'],
    ['#82ADD3','#D3E5EF','#4E759B'], ['#DF9472','#F2D9C7','#A26048'],
    ['#959BBD','#DCDDEA','#626A91'], ['#E6BC62','#F7E9BA','#AD8338'],
    ['#75B0AA','#CFE3D9','#4B7E79'], ['#D693B4','#F1D4E0','#A66585']
  ];
  // Flat, intentionally uneven silhouettes are the family resemblance.
  const silhouettes = [
    'M106 84L112 67L132 71L145 53L162 66L182 54L190 75L213 77L211 99L229 116L217 136L227 158L211 171L214 198L190 201L178 218L159 208L137 217L126 200L103 201L105 175L89 160L101 139L92 119L110 105Z',
    'M111 91L149 54Q155 48 163 56L200 83L215 101L217 163L228 187L207 203L174 208L160 219L138 208L108 209L94 190L106 162L102 111Z',
    'M108 79L185 68L214 96L221 192Q213 205 199 207L121 216L104 201L96 106Q96 89 108 79Z',
    'M116 81L153 77L171 68L194 80L211 95L219 177L213 200L190 213L123 211L102 195L98 116Z',
    'M99 85L100 65L123 64L126 81L148 78L150 56L171 55L174 80L196 78L196 64L220 66L220 98L214 181L224 200L198 213L170 207L147 216L120 209L101 211L109 183Z',
    'M158 56L175 75L199 67L201 92L224 98L214 119L233 138L213 152L225 175L203 183L201 207L178 202L162 222L145 203L119 211L116 188L94 180L105 156L88 140L108 122L98 99L121 91L125 69L148 77Z',
    'M109 88L153 67L202 79L221 107L213 161L205 183L179 209L159 221L130 207L111 185L101 160L99 110Z',
    'M112 82L143 73L184 82L205 105L222 151L205 180L190 207L154 219L122 202L104 171L91 135L102 106Z'
  ];
  const facePaths = [
    'M127 105Q157 99 190 106Q202 110 201 124L199 150Q196 160 182 161L137 160Q121 157 119 145L118 123Q116 111 127 105Z',
    'M128 106L187 104Q200 108 199 122L201 143Q197 158 181 162L142 160Q120 157 119 143L117 126Q116 111 128 106Z',
    'M121 107L188 100L201 112L201 148L190 162L125 162L116 150L116 119Z',
    'M125 104L190 102Q202 110 201 123L204 147Q200 160 185 163L131 160Q118 157 117 145L115 121Q117 109 125 104Z',
    'M124 105Q153 102 189 105L202 116L198 150Q192 161 180 163L136 160Q121 158 119 145L116 119Z',
    'M129 106Q158 98 188 105Q204 112 202 128L199 144Q194 160 179 163L139 161Q122 157 120 143L116 124Q118 112 129 106Z',
    'M128 104L184 102Q198 108 201 122L200 148L190 159L153 165L130 158Q117 153 117 138L117 119Z',
    'M125 108Q153 101 189 108Q199 111 201 124L202 145Q195 160 181 162L134 159Q121 157 118 143L116 127Q115 113 125 108Z'
  ];
  const css = `
    .paper-art { overflow:visible; }
    .paper-art .paper-puppet { transform-origin:160px 247px; animation:paper-breathe 3.8s ease-in-out infinite; }
    .paper-art .paper-head { transform-origin:160px 175px; }
    .paper-art .paper-left-arm { transform-origin:112px 151px; animation:paper-arm-drift 3.8s ease-in-out infinite; }
    .paper-art .paper-right-arm { transform-origin:210px 152px; animation:paper-arm-drift 3.8s ease-in-out infinite reverse; }
    .paper-art .paper-left-leg { transform-origin:140px 205px; }
    .paper-art .paper-right-leg { transform-origin:184px 205px; }
    .paper-art .paper-eyes { transform-origin:160px 130px; animation:paper-blink 5.6s ease-in-out infinite; }
    .paper-art .paper-shadow { transform-origin:160px 261px; animation:paper-shadow-breathe 3.8s ease-in-out infinite; }
    .paper-art .paper-fleck { animation:paper-float 2.6s ease-in-out infinite; transform-origin:160px 150px; }
    .paper-art .paper-fleck:nth-child(2) { animation-delay:-.8s; }
    .paper-art .paper-fleck:nth-child(3) { animation-delay:-1.7s; }
    .paper-art .paper-thought-dot { animation:paper-dot 1.65s ease-in-out infinite; }
    .paper-art .paper-thought-dot:nth-child(2) { animation-delay:.18s; }
    .paper-art .paper-thought-dot:nth-child(3) { animation-delay:.36s; }
    .paper-art[data-state="listening"] .paper-head { transform:rotate(-6deg); }
    .paper-art[data-state="listening"] .paper-right-arm { animation:paper-listen 2s ease-in-out infinite; }
    .paper-art[data-state="thinking"] .paper-head { animation:paper-think 3s ease-in-out infinite; }
    .paper-art[data-state="thinking"] .paper-right-arm { transform:rotate(121deg); animation:none; }
    .paper-art[data-state="working"] .paper-puppet { animation:paper-work .85s ease-in-out infinite; }
    .paper-art[data-state="working"] .paper-left-arm { animation:paper-craft .55s ease-in-out infinite; }
    .paper-art[data-state="working"] .paper-right-arm { animation:paper-craft .55s ease-in-out infinite reverse; }
    .paper-art[data-state="working"] .paper-right-leg { animation:paper-foot .55s ease-in-out infinite; }
    .paper-art[data-state="waiting_approval"] .paper-puppet { animation:paper-wait 3.5s ease-in-out infinite; }
    .paper-art[data-state="waiting_approval"] .paper-right-arm { transform:rotate(-58deg); animation:paper-offer 2.8s ease-in-out infinite; }
    .paper-art[data-state="waiting_approval"] .paper-head { transform:rotate(4deg); }
    .paper-art[data-state="success"] .paper-puppet { animation:paper-hop 1.65s cubic-bezier(.3,0,.3,1) infinite; }
    .paper-art[data-state="success"] .paper-left-arm { animation:paper-cheer-left 1.65s ease-in-out infinite; }
    .paper-art[data-state="success"] .paper-right-arm { animation:paper-cheer-right 1.65s ease-in-out infinite; }
    .paper-art[data-state="success"] .paper-left-leg { transform:rotate(10deg); }
    .paper-art[data-state="success"] .paper-right-leg { transform:rotate(-13deg); }
    .paper-art[data-state="success"] .paper-shadow { animation:paper-hop-shadow 1.65s ease-in-out infinite; }
    .paper-art[data-state="failure"] .paper-puppet { animation:paper-oops 3s ease-in-out infinite; }
    .paper-art[data-state="failure"] .paper-head { transform:rotate(-8deg) translateY(4px); }
    .paper-art[data-state="failure"] .paper-left-arm { transform:rotate(12deg); animation:none; }
    .paper-art[data-state="failure"] .paper-right-arm { transform:rotate(-13deg); animation:none; }
    .paper-art[data-state="offline"] .paper-puppet { transform:translateY(7px) rotate(4deg); animation:paper-sleep 5s ease-in-out infinite; opacity:.73; }
    .paper-art[data-state="offline"] .paper-head { transform:rotate(8deg); }
    .paper-art[data-state="offline"] .paper-eyes, .paper-art[data-state="offline"] .paper-left-arm, .paper-art[data-state="offline"] .paper-right-arm { animation:none; }
    @keyframes paper-breathe { 0%,100% {transform:translateY(0) rotate(-1.2deg)} 50% {transform:translateY(-4px) rotate(1.2deg)} }
    @keyframes paper-arm-drift { 0%,100% {transform:rotate(-3deg)} 50% {transform:rotate(5deg)} }
    @keyframes paper-shadow-breathe { 0%,100% {transform:scaleX(1);opacity:.11} 50% {transform:scaleX(.93);opacity:.085} }
    @keyframes paper-blink { 0%,43%,47%,100% {transform:scaleY(1)} 45% {transform:scaleY(.12)} }
    @keyframes paper-listen { 0%,100% {transform:rotate(-113deg)} 50% {transform:rotate(-121deg)} }
    @keyframes paper-think { 0%,100% {transform:rotate(5deg)} 50% {transform:rotate(10deg) translateY(-2px)} }
    @keyframes paper-work { 0%,100% {transform:translateY(0) rotate(-2deg)} 50% {transform:translateY(-3px) rotate(2deg)} }
    @keyframes paper-craft { 0%,100% {transform:rotate(-22deg)} 50% {transform:rotate(18deg)} }
    @keyframes paper-foot { 0%,100% {transform:rotate(0)} 50% {transform:rotate(-8deg)} }
    @keyframes paper-wait { 0%,100% {transform:rotate(-2deg)} 50% {transform:rotate(2deg)} }
    @keyframes paper-offer { 0%,100% {transform:rotate(-58deg)} 50% {transform:rotate(-65deg)} }
    @keyframes paper-hop { 0%,70%,100% {transform:translateY(0) rotate(-2deg)} 27%,38% {transform:translateY(-17px) rotate(4deg)} 55% {transform:translateY(1px) rotate(-3deg)} }
    @keyframes paper-cheer-left { 0%,100% {transform:rotate(115deg)} 35% {transform:rotate(138deg)} }
    @keyframes paper-cheer-right { 0%,100% {transform:rotate(-116deg)} 35% {transform:rotate(-136deg)} }
    @keyframes paper-hop-shadow { 0%,70%,100% {transform:scaleX(1);opacity:.11} 30% {transform:scaleX(.75);opacity:.05} }
    @keyframes paper-oops { 0%,20%,100% {transform:translateX(0) rotate(-3deg)} 5% {transform:translateX(-3px) rotate(-5deg)} 10% {transform:translateX(3px) rotate(-1deg)} 15% {transform:translateX(-2px) rotate(-4deg)} }
    @keyframes paper-sleep { 0%,100% {transform:translateY(7px) rotate(4deg)} 50% {transform:translateY(5px) rotate(5deg)} }
    @keyframes paper-float { 0%,100% {transform:translateY(0) rotate(-5deg)} 50% {transform:translateY(-7px) rotate(7deg)} }
    @keyframes paper-dot { 0%,65%,100% {opacity:.3} 30% {opacity:1} }
  `;
  function face(state, i) {
    const ink = '#393336';
    const closed = state === 'success' || state === 'offline';
    const gazeX = state === 'thinking' ? 2 : state === 'listening' ? 2 : 0;
    const gazeY = state === 'thinking' ? -3 : 0;
    let eyes;
    if (closed) eyes = state === 'success'
      ? '<path d="M137 130Q142 123 147 130M174 130Q179 123 184 130" fill="none" stroke-width="3.5" stroke-linecap="round"/>'
      : '<path d="M137 132Q142 136 147 132M174 132Q179 136 184 132" fill="none" stroke-width="3" stroke-linecap="round"/>';
    else eyes = `<g transform="translate(${gazeX} ${gazeY})"><ellipse cx="142" cy="129" rx="${state==='listening'?4.1:3.6}" ry="${state==='listening'?6:5}"/><ellipse cx="179" cy="129" rx="${state==='listening'?4.1:3.6}" ry="${state==='listening'?6:5}"/><circle cx="143" cy="127" r="1.1" fill="#FFFBEC"/><circle cx="180" cy="127" r="1.1" fill="#FFFBEC"/></g>`;
    const brows = state === 'failure' ? '<path d="M136 118L147 115M174 115L184 118" fill="none" stroke-width="2.2" stroke-linecap="round"/>' : state === 'thinking' ? '<path d="M174 115L184 112" fill="none" stroke-width="2.2" stroke-linecap="round"/>' : '';
    const mouths = {
      idle: '<path d="M154 142Q160 147 167 141"/>',
      listening: '<ellipse cx="160" cy="144" rx="3.2" ry="3.7" fill="#393336" stroke="none"/>',
      thinking: '<path d="M157 144L164 143"/>',
      working: '<path d="M154 143Q160 147 166 143"/><path d="M162 145Q168 143 169 147Q167 152 163 148" fill="#DFA19D" stroke="none"/>',
      waiting_approval: '<path d="M154 143Q160 147 167 142"/>',
      success: '<path d="M152 141Q160 144 169 140Q168 154 160 153Q153 152 152 141Z" fill="#393336" stroke="none"/><path d="M156 150Q161 145 166 149Q162 154 156 150Z" fill="#DFA19D" stroke="none"/>',
      failure: '<path d="M155 147Q160 142 166 147"/>',
      offline: '<path d="M157 147L163 147"/>'
    };
    const glasses = i === 2 ? '<g fill="none" stroke="#4E759B" stroke-width="2.5"><circle cx="142" cy="130" r="12"/><circle cx="179" cy="130" r="12"/><path d="M154 128Q160 125 167 128M130 127L119 123M191 127L201 123"/></g>' : '';
    return `<g class="paper-face"><ellipse cx="130" cy="144" rx="6" ry="3.2" fill="#E9A99A" opacity=".55"/><ellipse cx="189" cy="143" rx="6" ry="3.2" fill="#E9A99A" opacity=".55"/><g class="paper-eyes" fill="${ink}" stroke="${ink}">${eyes}${brows}</g>${glasses}<g stroke="${ink}" stroke-width="2.5" stroke-linecap="round" fill="none">${mouths[state] || mouths.idle}</g></g>`;
  }
  function accessory(i,c,l,d) {
    const ink = '#51424A';
    return [
      `<path d="M146 70L158 76L168 65L173 81L187 80L179 98L145 95Z" fill="#E9BD65"/><path d="M149 89L178 92" stroke="#FFF1C3" stroke-width="2"/><circle cx="163" cy="85" r="3" fill="${d}"/><path d="M144 177L160 168L177 178L175 193L159 204L143 192Z" fill="${l}"/><path d="M153 186L160 177L166 186L159 194Z" fill="${d}"/>`,
      `<path d="M152 57Q184 45 190 55Q184 74 164 81Z" fill="${d}"/><path d="M158 75L180 57" stroke="${l}" stroke-width="2"/><path d="M118 170L190 196" stroke="${d}" stroke-width="11"/><path d="M144 178L164 175L181 182L177 201L157 195L139 199Z" fill="#FFF6DD"/><path d="M151 178L147 196M166 178L161 197" stroke="#DED4B9" stroke-width="1.4"/><path d="M152 189L159 184L169 190" stroke="${d}" stroke-width="1.6" fill="none"/><circle cx="169" cy="190" r="2" fill="#D18963"/>`,
      `<path d="M185 68L184 98L214 96Z" fill="${l}"/><path d="M184 98L188 95L213 100Z" fill="${d}" opacity=".25"/><path d="M110 88L117 84L125 191L118 190Z" fill="${d}" opacity=".25"/><path d="M178 173L190 172L193 202L186 198L181 204Z" fill="#DF9676"/><path d="M138 179L164 176L165 195L139 198Z" fill="#FFF6DD"/><path d="M145 184L158 182M145 190L157 188" stroke="${d}" stroke-width="2" stroke-linecap="round"/>`,
      `<g transform="rotate(19 211 108)"><path d="M207 71L215 71L215 117L211 126L207 117Z" fill="#E8BC5E"/><path d="M207 71L215 71L215 78L207 78Z" fill="#EDC0BE"/><path d="M207 117L215 117L211 126Z" fill="#FFF3D7"/><path d="M209 123L211 127L213 123Z" fill="${ink}"/></g><path d="M128 170L143 176L155 167L170 176L185 170L188 204L128 207Z" fill="${l}"/><path d="M150 180L178 179L177 196L150 198Z" fill="${d}"/><path d="M155 184L173 183M155 192L172 191" stroke="${l}" stroke-width="1.6" stroke-dasharray="2 3"/>`,
      `<path d="M126 83L195 81L198 98L123 101Z" fill="${d}"/><path d="M138 83L140 97M181 82L181 97" stroke="${l}" stroke-width="2" opacity=".7"/><path d="M141 175L177 173L181 201L145 206Z" fill="#FFF6DF"/><path d="M150 182L154 185L160 178M152 195L156 198L162 190" fill="none" stroke="${d}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M166 182L173 181M167 194L175 193" stroke="#BDB0A2" stroke-width="2"/>`,
      `<path d="M143 85L158 69L170 87L181 79L179 97L138 99L131 85Z" fill="${l}"/><path d="M155 172L170 172L162 183L174 183L153 203L158 189L148 189Z" fill="#FFF6DC"/><path d="M205 174L216 179L211 188L201 184Z" fill="#ED9B7B"/>`,
      `<path d="M109 86L153 68L202 79L212 97L161 88L103 106Z" fill="${d}"/><path d="M154 69L161 88L202 79" fill="${l}" opacity=".55"/><path d="M145 174L161 169L179 174L176 192L161 203L147 193Z" fill="#FFF6DF"/><circle cx="162" cy="182" r="4.2" fill="${d}"/><path d="M160 184L159 193L166 192L164 184Z" fill="${d}"/>`,
      `<path d="M111 94Q107 74 141 66Q177 61 203 85L200 96L151 91Z" fill="${d}"/><path d="M119 91L198 91L204 103L117 101Z" fill="${l}"/><path d="M180 77Q186 49 211 46Q216 66 199 81L187 89Z" fill="#FFF4DB"/><path d="M185 87L206 54M193 73L202 72M197 65L204 63" fill="none" stroke="#B69C87" stroke-width="1.4"/><path d="M143 178L178 175L182 199L147 205Z" fill="#FFF4DB"/><path d="M151 185L171 183M153 192L168 190M154 198L174 195" stroke="${d}" stroke-width="1.7" stroke-linecap="round"/>`
    ][i];
  }
  function atmosphere(state,c,l,d) {
    if (state === 'thinking') return `<g fill="${d}"><circle class="paper-thought-dot" cx="237" cy="93" r="3"/><circle class="paper-thought-dot" cx="247" cy="78" r="4.5"/><circle class="paper-thought-dot" cx="259" cy="63" r="6"/></g>`;
    if (state === 'listening') return `<g class="paper-fleck" fill="none" stroke="${d}" stroke-width="2.4" stroke-linecap="round"><path d="M243 102Q252 114 244 126M255 96Q269 113 258 133"/></g>`;
    if (state === 'success') return `<g><path class="paper-fleck" d="M76 86L82 72L88 84L101 88L89 95L86 108L78 97L66 93Z" fill="#E4B85F"/><path class="paper-fleck" d="M239 69L250 63L253 75L244 82Z" fill="${c}"/><path class="paper-fleck" d="M239 146L245 136L251 146L261 152L250 156L244 167L240 156L231 153Z" fill="${l}"/><path class="paper-fleck" d="M73 165L79 169L74 181L69 177Z" fill="#DFA384"/></g>`;
    if (state === 'waiting_approval') return `<g class="paper-fleck"><path d="M236 121L263 117L269 141L241 146Z" fill="#FFF6DF"/><path d="M241 132L248 137L259 125" stroke="${d}" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M244 151L247 155" stroke="${d}" stroke-width="2" stroke-linecap="round"/></g>`;
    if (state === 'failure') return `<g class="paper-fleck"><path d="M234 95L247 99L257 91L264 103L256 115L242 112Z" fill="#E2C8BC"/><path d="M245 101L253 108M252 101L246 108" stroke="#9E786B" stroke-width="1.8" stroke-linecap="round"/></g>`;
    if (state === 'offline') return `<g class="paper-fleck" fill="none" stroke="${d}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" opacity=".7"><path d="M229 93L239 91L232 105L243 103M249 71L260 69L253 83L264 81"/></g>`;
    if (state === 'working') return `<g class="paper-fleck" fill="${l}"><path d="M73 143L80 147L76 154L68 150Z"/><path d="M236 186L245 181L250 188L240 193Z"/><path d="M244 90L250 94L247 101L241 97Z"/></g>`;
    return `<g class="paper-fleck" fill="${l}" opacity=".8"><path d="M239 94L244 84L249 93L258 97L249 102L245 112L240 103L231 99Z"/></g>`;
  }
  window.PipConcepts = window.PipConcepts || {};
  window.PipConcepts.paper = {
    name: 'Paper pals',
    tagline: 'Cut from a different cloth. Well, paper.',
    description: 'A tiny picture-book team: folded paper, little mittens, and a different silhouette for every personality.',
    styles: css,
    markup(pip, state = 'idle', uid = 'paper', options = {}) {
      const found = names.indexOf(pip.name);
      const i = ((Number.isInteger(pip.index) ? pip.index : Math.max(0, found)) % 8 + 8) % 8;
      const [c,l,d] = palettes[i];
      const id = `paper-${String(uid).replace(/[^a-zA-Z0-9_-]/g, '')}`;
      const validStates = ['idle','listening','thinking','working','waiting_approval','success','failure','offline'];
      if (!validStates.includes(state)) state = 'idle';
      const body = silhouettes[i];
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 300" class="paper-art" data-state="${state}" aria-hidden="true" focusable="false">
        ${options.includeStyles === false ? '' : `<style>${css}</style>`}
        <defs><pattern id="${id}-grain" width="18" height="19" patternUnits="userSpaceOnUse"><circle cx="3" cy="5" r=".65" fill="#583D38" opacity=".08"/><circle cx="12" cy="14" r=".7" fill="#FFF8E9" opacity=".22"/><path d="M12 3L14 4M5 14L6 16" stroke="#FFF8E9" opacity=".15" stroke-width=".7"/></pattern><clipPath id="${id}-cut"><path d="${body}"/></clipPath></defs>
        <ellipse class="paper-shadow" cx="160" cy="261" rx="61" ry="7" fill="#756757" opacity=".11"/>
        ${atmosphere(state,c,l,d)}
        <g class="paper-puppet">
          <g class="paper-left-leg"><path d="M129 197L150 199L146 242L133 246Z" fill="${d}"/><path d="M132 205L145 207L142 239L134 241Z" fill="${l}"/><path d="M131 239Q141 236 148 243L151 252Q143 258 126 256L120 253L121 246Z" fill="#4A3B3C"/><path d="M125 253L146 253" stroke="#FCEDCD" stroke-width="2.4" stroke-linecap="round"/></g>
          <g class="paper-right-leg"><path d="M174 199L195 197L190 244L179 247Z" fill="${d}"/><path d="M180 205L190 204L186 241L180 240Z" fill="${l}"/><path d="M178 241Q186 237 194 242L201 248L202 254Q188 259 177 254L174 250Z" fill="#4A3B3C"/><path d="M181 253L197 252" stroke="#FCEDCD" stroke-width="2.4" stroke-linecap="round"/></g>
          <g class="paper-left-arm"><path d="M114 141L125 153L91 191L79 184Z" fill="${d}"/><path d="M109 148L116 153L88 184L83 180Z" fill="${l}"/><path d="M80 179Q87 177 94 184L93 197Q88 205 79 201Q69 199 70 191L72 184Q73 179 77 181L81 186Z" fill="#FFF2D5"/><path d="M79 186L84 190" stroke="#D8BD99" stroke-width="1.5" stroke-linecap="round"/></g>
          <g class="paper-right-arm"><path d="M201 143L214 145L239 184L228 192L203 163Z" fill="${d}"/><path d="M210 152L215 152L235 184L229 187Z" fill="${l}"/><path d="M231 180Q238 179 244 185L248 193Q247 202 239 203Q231 205 225 198L224 190Q224 184 228 184L231 189Z" fill="#FFF2D5"/><path d="M232 188L236 192" stroke="#D8BD99" stroke-width="1.5" stroke-linecap="round"/></g>
          <g class="paper-head">
            <path d="${body}" fill="${d}" transform="translate(3 5)"/>
            <path d="${body}" fill="${c}"/>
            <g clip-path="url(#${id}-cut)"><path d="M87 61L155 75L137 215L79 220Z" fill="${l}" opacity=".38"/><path d="M178 64L164 216L231 216L237 82Z" fill="${d}" opacity=".095"/><path d="M157 69L147 110M147 164L137 211" stroke="#FFF7E7" stroke-width="1.6" opacity=".45"/><path d="${body}" fill="url(#${id}-grain)"/></g>
            <path d="${facePaths[i]}" fill="${d}" opacity=".24" transform="translate(1 3)"/>
            <path d="${facePaths[i]}" fill="#FFF4DB"/>
            <path d="${facePaths[i]}" fill="url(#${id}-grain)"/>
            ${face(state,i)}
            ${accessory(i,c,l,d)}
          </g>
        </g>
      </svg>`;
    }
  };
})();
