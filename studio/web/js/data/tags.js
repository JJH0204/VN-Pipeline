// 프롬프트 도우미 태그 (Danbooru 태그 표기 그대로, 한국어 설명)
// [태그, 한국어 라벨]

export const TAG_CATEGORIES = [
  {
    id: 'expression', label: '표정', tags: [
      ['smile', '미소'], ['light smile', '옅은 미소'], ['grin', '이를 드러낸 웃음'], [':d', '활짝 웃는 입'],
      ['laughing', '소리 내어 웃음'], ['smug', '의기양양'], ['happy', '행복함'], ['open mouth', '입 벌림'],
      ['closed mouth', '입 다묾'], ['blush', '홍조'], ['embarrassed', '부끄러움'], ['pout', '뾰로통'],
      ['puffy cheeks', '볼 부풀리기'], ['angry', '화남'], ['v-shaped eyebrows', '찡그린 눈썹'], ['frown', '찌푸림'],
      ['sad', '슬픔'], ['tearing up', '눈물 글썽'], ['tears', '눈물'], ['crying', '울음'],
      ['surprised', '놀람'], ['wide-eyed', '휘둥그레진 눈'], ['scared', '겁먹음'], ['worried', '걱정'],
      ['nervous', '긴장'], ['confused', '어리둥절'], ['expressionless', '무표정'], ['serious', '진지함'],
      ['determined', '결의'], ['sleepy', '졸림'], ['one eye closed', '윙크'], ['tongue out', '혀 내밀기'],
      ['sweatdrop', '식은땀(만화 표현)'],
    ],
  },
  {
    id: 'pose', label: '포즈', tags: [
      ['standing', '서 있기'], ['sitting', '앉기'], ['kneeling', '무릎 꿇기'], ['seiza', '정좌'],
      ['squatting', '쪼그려 앉기'], ['lying', '누워 있기'], ['on back', '똑바로 눕기'], ['on stomach', '엎드리기'],
      ['walking', '걷기'], ['running', '달리기'], ['jumping', '점프'], ['leaning forward', '앞으로 숙이기'],
      ['arms at sides', '팔 내리기(차렷)'], ['arms behind back', '뒷짐'], ['arms up', '팔 들기'], ['crossed arms', '팔짱'],
      ['hands on own hips', '허리에 손'], ['hand on own chest', '가슴에 손'], ['hand on own cheek', '볼에 손'],
      ['own hands together', '두 손 모으기'], ['v', '브이(V 사인)'], ['waving', '손 흔들기'], ['salute', '경례'],
      ['outstretched arms', '팔 벌리기'], ['reaching towards viewer', '화면 쪽으로 손 뻗기'], ['stretching', '기지개'],
      ['head tilt', '고개 갸웃'], ['crossed legs', '다리 꼬기'], ['hugging own legs', '무릎 끌어안기'],
    ],
  },
  {
    id: 'composition', label: '구도', tags: [
      ['full body', '전신'], ['upper body', '상반신'], ['cowboy shot', '허벅지 위(카우보이 샷)'], ['portrait', '얼굴·어깨(초상)'],
      ['close-up', '클로즈업'], ['lower body', '하반신'], ['wide shot', '원경'], ['very wide shot', '아주 먼 원경'],
      ['from above', '위에서(부감)'], ['from below', '아래에서(앙각)'], ['from side', '옆에서'], ['from behind', '뒤에서'],
      ['straight-on', '정면 구도'], ['profile', '옆얼굴'], ['dutch angle', '기울어진 구도'], ['pov', '1인칭 시점'],
      ['foreshortening', '원근 강조'], ['fisheye', '어안 렌즈'], ['feet out of frame', '발 잘림'], ['head out of frame', '머리 잘림'],
      ['solo focus', '한 명에 초점'], ['multiple views', '여러 각도(설정화)'], ['symmetry', '대칭'],
    ],
  },
  {
    id: 'gaze', label: '시선', tags: [
      ['looking at viewer', '화면을 봄'], ['looking away', '시선 회피'], ['looking to the side', '옆을 봄'], ['looking back', '뒤돌아봄'],
      ['looking up', '위를 봄'], ['looking down', '아래를 봄'], ['looking afar', '먼 곳을 봄'], ['looking ahead', '앞을 봄'],
      ['looking at another', '다른 사람을 봄'], ['looking outside', '바깥을 봄'], ['looking at phone', '휴대폰을 봄'], ['eye contact', '눈 맞춤'],
      ['facing viewer', '몸이 정면'], ['facing away', '등 돌림'], ['sideways glance', '곁눈질'], ['half-closed eyes', '반쯤 감은 눈'],
      ['closed eyes', '눈 감음'], ['upturned eyes', '올려다보는 눈'], ['glaring', '노려봄'], ['sparkling eyes', '반짝이는 눈'],
      ['empty eyes', '초점 없는 눈'], ['eyes visible through hair', '머리카락 사이로 보이는 눈'],
    ],
  },
  {
    id: 'outfit', label: '의상', tags: [
      ['school uniform', '교복'], ['serafuku', '세라복'], ['sailor collar', '세일러 칼라'], ['blazer', '블레이저'],
      ['pleated skirt', '주름치마'], ['miniskirt', '미니스커트'], ['necktie', '넥타이'], ['neck ribbon', '리본 타이'],
      ['collared shirt', '칼라 셔츠'], ['sweater', '스웨터'], ['cardigan', '카디건'], ['hoodie', '후드티'],
      ['jacket', '재킷'], ['coat', '코트'], ['dress', '원피스'], ['sundress', '선드레스'],
      ['maid', '메이드복'], ['apron', '앞치마'], ['kimono', '기모노'], ['yukata', '유카타'],
      ['china dress', '치파오'], ['miko', '무녀복'], ['gym uniform', '체육복'], ['pajamas', '잠옷'],
      ['swimsuit', '수영복'], ['suit', '정장'], ['armor', '갑옷'], ['thighhighs', '사이하이 스타킹'],
      ['pantyhose', '팬티스타킹'], ['socks', '양말'], ['loafers', '로퍼'], ['sneakers', '운동화'],
      ['glasses', '안경'], ['hat', '모자'], ['beret', '베레모'], ['scarf', '목도리'], ['gloves', '장갑'],
    ],
  },
  {
    id: 'hair', label: '헤어', tags: [
      ['long hair', '긴 머리'], ['medium hair', '중간 길이 머리'], ['short hair', '짧은 머리'], ['very long hair', '아주 긴 머리'],
      ['bob cut', '단발(보브)'], ['ponytail', '포니테일'], ['high ponytail', '하이 포니테일'], ['side ponytail', '사이드 포니테일'],
      ['twintails', '트윈테일'], ['braid', '땋은 머리'], ['side braid', '옆으로 땋은 머리'], ['twin braids', '양갈래 땋은 머리'],
      ['hair bun', '똥머리(번)'], ['double bun', '양쪽 번'], ['hime cut', '히메컷'], ['blunt bangs', '일자 앞머리'],
      ['swept bangs', '옆으로 넘긴 앞머리'], ['hair between eyes', '눈 사이로 내려온 앞머리'], ['sidelocks', '옆머리'], ['ahoge', '바보털'],
      ['wavy hair', '웨이브'], ['messy hair', '부스스한 머리'], ['hair ribbon', '머리 리본'], ['hairclip', '머리핀'],
      ['hairband', '머리띠'], ['hair flower', '꽃 머리 장식'], ['black hair', '검은 머리'], ['brown hair', '갈색 머리'],
      ['blonde hair', '금발'], ['white hair', '흰 머리'], ['grey hair', '은회색 머리'], ['pink hair', '분홍 머리'],
      ['blue hair', '파란 머리'], ['red hair', '빨간 머리'],
    ],
  },
  {
    id: 'background', label: '배경', tags: [
      ['simple background', '단순 배경'], ['white background', '흰 배경'], ['gradient background', '그라데이션 배경'], ['scenery', '풍경'],
      ['no humans', '인물 없음'], ['indoors', '실내'], ['outdoors', '실외'], ['classroom', '교실'],
      ['hallway', '복도'], ['rooftop', '옥상'], ['library', '도서관'], ['cafe', '카페'],
      ['bedroom', '침실'], ['kitchen', '부엌'], ['park', '공원'], ['street', '거리'],
      ['city', '도시'], ['cityscape', '도시 전경'], ['train interior', '열차 안'], ['shrine', '신사'],
      ['beach', '해변'], ['ocean', '바다'], ['forest', '숲'], ['flower field', '꽃밭'],
      ['cherry blossoms', '벚꽃'], ['blue sky', '파란 하늘'], ['cloud', '구름'], ['night sky', '밤하늘'],
      ['starry sky', '별이 빛나는 하늘'], ['winter', '겨울'], ['summer', '여름'],
    ],
  },
  {
    id: 'lighting', label: '조명', tags: [
      ['sunlight', '햇빛'], ['dappled sunlight', '나뭇잎 사이 햇살'], ['light rays', '빛줄기'], ['backlighting', '역광'],
      ['rim lighting', '윤곽광(림 라이트)'], ['moonlight', '달빛'], ['sunset', '노을'], ['sunrise', '일출'],
      ['twilight', '황혼'], ['evening', '저녁'], ['night', '밤'], ['day', '낮'],
      ['overcast', '흐린 날'], ['lens flare', '렌즈 플레어'], ['spotlight', '스포트라이트'], ['candlelight', '촛불 조명'],
      ['neon lights', '네온 조명'], ['silhouette', '실루엣'], ['shadow', '그림자'], ['dark', '어두움'],
      ['high contrast', '높은 대비'],
    ],
  },
  {
    id: 'effect', label: '효과', tags: [
      ['depth of field', '피사계 심도'], ['blurry background', '배경 흐림'], ['bokeh', '보케'], ['chromatic aberration', '색수차'],
      ['bloom', '빛 번짐(블룸)'], ['film grain', '필름 그레인'], ['vignetting', '비네팅'], ['light particles', '빛 입자'],
      ['sparkle', '반짝임'], ['glint', '반사광'], ['glowing', '빛나는'], ['motion blur', '모션 블러'],
      ['speed lines', '속도선'], ['motion lines', '움직임 선'], ['emphasis lines', '집중선'], ['wind', '바람'],
      ['floating hair', '흩날리는 머리'], ['petals', '꽃잎'], ['falling petals', '떨어지는 꽃잎'], ['snowing', '눈 내림'],
      ['rain', '비'], ['bubble', '비눗방울'], ['confetti', '색종이'], ['fog', '안개'],
      ['heart', '하트'], ['musical note', '음표'],
    ],
  },
];
