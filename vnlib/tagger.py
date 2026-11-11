"""이미지 → Danbooru 태그 추출 (SmilingWolf WD 태거 v3, onnxruntime). CLI(vn.py tag)와 Studio가 함께 쓴다.

  from vnlib import tagger
  res = tagger.predict_file("output/haru/sprite/haru_base_00001_.png")
  res["tags"]  # [{"tag": "long hair", "score": 0.97, "kind": "general", "group": "appearance"}, ...]
  tagger.to_prompt([t for t in res["tags"] if t["score"] >= 0.35 and t["group"] != "meta"])

모델: models/tagger/<이름>/{model.onnx, selected_tags.csv} (config.model_dirs("tagger") 아래).
numpy·Pillow·onnxruntime은 함수 안에서 불러온다 — 이 모듈을 import만 하는 CLI의 다른 명령(엔진 Python이 아닌
python3로 실행해도)이 깨지지 않게. 없으면 TaggerError(한국어)로 알린다.
"""
import csv
import functools
import re
import threading
import time
from pathlib import Path

from . import config

DEFAULT_MODEL = "wd-eva02-large-tagger-v3"
MODEL_FILE = "model.onnx"
TAGS_FILE = "selected_tags.csv"
FLOOR = 0.15            # 이 점수 이상인 일반 태그만 돌려준다 (UI가 기준값 슬라이더로 다시 거름)
CHAR_FLOOR = 0.5        # 캐릭터 태그는 이 점수 이상만
MAX_PIXELS = 50_000_000  # 이보다 큰 이미지는 거부 (전역 Image.MAX_IMAGE_PIXELS는 갤러리 썸네일에도 쓰이므로 건드리지 않음)
PAD_MAX = 4096           # 긴 변이 이보다 큰 직사각형은 정사각 패딩 전에 이 크기로 줄임 (메모리 보호)
DEFAULT_SIZE = 448

GROUPS = ("count", "character", "appearance", "outfit", "expression", "pose",
          "composition", "background", "other", "meta")
GROUP_LABELS = {"count": "인원", "character": "캐릭터", "appearance": "외형", "outfit": "의상",
                "expression": "표정", "pose": "포즈", "composition": "구도", "background": "배경",
                "other": "기타", "meta": "제외 권장"}
RATINGS = ("general", "sensitive", "questionable", "explicit")

# 밑줄을 공백으로 바꾸면 안 되는 이모티콘 태그
EMOTICONS = frozenset((
    "^_^", ">_<", "o_o", "0_0", "@_@", "x_x", "=_=", "u_u", "+_+", "._.", "|_|", "||_||",
    "<o>_<o>", "<|>_<|>", "(o)_(o)", "3_3", "6_9", ">_o", "+_-"))

HELP_HINT = "자세한 방법은 도움말 › 프롬프트 추출을 보세요."


class TaggerError(RuntimeError):
    """태거를 쓸 수 없음 / 이미지를 읽을 수 없음. 메시지는 한국어.

    kind: "unavailable"(onnxruntime 없음·모델 없음·모델 손상) | "not_found"(요청한 모델 이름이 없음)
          | "image"(이미지를 읽을 수 없음·너무 큼) | "error"(추론 실패)
    """

    def __init__(self, message, kind="error"):
        super().__init__(message)
        self.kind = kind


# ====================================================================== 태그 분류 규칙
# classify(tag)는 위에서부터 차례로 검사해 처음 맞는 그룹을 고른다. 어디에도 안 맞으면 "other".
# 1) EXACT (정확히 일치) → 2) RULES 정규식 (순서 중요: 앞쪽 규칙이 우선).
# 태그는 소문자·공백 표기("long hair")로 비교한다.

def _words(*items):
    return frozenset(w.strip() for s in items for w in s.split(",") if w.strip())


# 원본(3D 렌더·자료 화면·글자) 특성 태그 — 생성 프롬프트에는 넣지 않는 편이 좋음
META_EXACT = _words(
    "3d, realistic, photorealistic, cgi, render, figure, figurine, doll, tachi-e, transparent background",
    "vrchat, mmd, koikatsu, unity, blender, second life, 3d model, model, mannequin",
    "signature, watermark, text, logo, artist logo, company logo, artist name, character name, copyright name",
    "english text, japanese text, chinese text, korean text, romaji text, translated, translation request",
    "web address, twitter username, patreon username, pixiv id, username, dated, commentary, official art",
    "multiple views, reference sheet, character sheet, model sheet, turnaround, variations, expressions",
    "column lineup, lineup, expression chart, color guide, character profile, sketch, lineart, line art",
    "virtual youtuber, comic, 4koma, manga, doujin cover, cover, cover page, magazine cover, page number",
    "speech bubble, thought bubble, sound effects, onomatopoeia, subtitled, text focus, sign language",
    "border, white border, black border, outside border, rounded corners, letterboxed, pillarboxed, framed",
    "jpeg artifacts, lowres, highres, absurdres, scan, screencap, anime screenshot, game cg, game screenshot",
    "parody, meme, crossover, one-hour drawing challenge, happy birthday, happy new year, merry christmas",
    "censored, uncensored, mosaic censoring, bar censor, heart censor, convenient censoring, novelty censor",
    "qr code, barcode, copyright notice, progress bar, health bar, user interface, watermark grid",
)
META_RULES = (
    r"^(blender|mikumikudance|koikatsu|3d|photo|unity|dakimakura|card|poster|tarot|calendar) \(medium\)$",
    r"^(blender|mikumikudance|koikatsu|honey select|vrchat|vroid|unity|daz)( \((medium|software)\))?$",
    r"(^| )text$", r"username$", r"^spoken ", r"^(artist|company|character|copyright) (name|logo)",
    r"^(official|promotional) ", r"^(reference|character|model|expression|color|size|turnaround) (sheet|chart)$",
    r"^cover ", r" cover$", r"(^| )censor(ed|ing)?$", r"watermark", r" logo$", r"\b\dkoma$", r"\bcomic\b",
    r"^\d{4}$", r" connection$", r"namesake$", r"^happy (birthday|new year|halloween|valentine|holidays)",
    r"^merry christmas",
)

# 노골적인 성적 표현·미성년자를 성적으로 다루는 태그 — 생성 기본 네거티브(nsfw)와 맞춰 기본으로 빼 둔다
SENSITIVE_EXACT = _words(
    "loli, shota, mesugaki, oppai loli, toddlercon, milf",
    "nude, completely nude, topless, bottomless, no bra, no panties, breasts out, nipples, covered nipples",
    "puffy nipples, inverted nipples, areolae, areola slip, nipple slip, pussy, penis, testicles, erection",
    "anus, pubic hair, female pubic hair, male pubic hair, pussy juice, spread pussy, cameltoe, bulge",
    "sex, after sex, group sex, clothed sex, sex from behind, vaginal, anal, oral, fellatio, paizuri",
    "handjob, footjob, masturbation, female masturbation, male masturbation, fingering, cunnilingus",
    "cowgirl position, missionary, doggystyle, girl on top, boy on top, straddling penis, 69, :>=",
    "cum, cumdrip, ejaculation, facial, bukkake, condom, sex toy, vibrator, dildo, object insertion",
    "rape, futanari, bdsm, bondage, bound, restrained, gag, gagged, shibari, collar and leash",
    "pantyshot, upskirt, panty pull, skirt lift, dress lift, shirt lift, clothes lift, bikini pull",
    "undressing, ass focus, breast focus, crotch, groin, between breasts, grabbing another's breast",
    "breast grab, ass grab, breasts squeezed together, bouncing breasts, butt crack, breast press",
    "covering privates, covering breasts, covering crotch, ass visible through thighs, ahegao, torogao",
    "saliva, saliva trail, pee, peeing, lactation, guro, vore, tentacle sex, implied sex, cum in pussy",
    "cum on body, cum on breasts, cum in mouth, cum on hair, after vaginal, imminent sex, presenting",
    "nipple tweak, breast sucking, breast hold, lifted by self, sex machine",
)
SENSITIVE_RULES = (
    r"\b(nipples?|pussy|penis|cum|sex|fellatio|paizuri|masturbation|vaginal|anal|erection|testicles|areolae?)\b",
    r"\b(loli|shota|lolicon|shotacon)\b", r"\bcensor", r"\bnude\b", r"\bpubic\b", r"\bcrotch\b", r"^naked ",
    r"\b(orgasm|precum|penetration|threesome|foursome|gangbang|handjob|footjob|blowjob|deepthroat|irrumatio)\b",
    r"\b(cunnilingus|bukkake|cumshot|ejaculat\w*|vibrator|dildo|butt plug|anal beads|gag|gagged|rape|raped)\b",
    r"\b(bestiality|pokephilia|incest|netorare|femdom|exhibitionism|indecency|defloration|spitroast|condom)\b",
    r"\b(foreskin|crotchless|maebari|pasties|wedgie|uterus|mons|downblouse|flashing|moaning|flaccid|fucked)\b",
    r"\b(sexually suggestive|suggestive fluid|cowgirl position|reverse cowgirl|full nelson|mating press)\b",
    r"^bound\b", r"\b(panty|bra|anus|pussy|nipple|areola|pantsu) peek$", r"^unworn (panties|bra|bikini|underwear)",
    r"\b(bikini|bra|panties|panty|swimsuit|leotard|clothes|clothing|skirt|shirt|dress|shorts|pants|pantyhose|"
    r"kimono|sweater|strap|towel|top|bottom|underwear|thong|legwear|bodysuit|apron|buruma|bloomers|bikini top|"
    r"bikini bottom|one-piece swimsuit|hakama|robe|jacket|coat) (aside|pull|lift|removed)$",
    r"^breasts? (rest|lift|suppress|envy|grab|press|hold|sucking|squeeze|smother|on|out|slip|bondage|"
    r"expansion|milk|padding|conscious|poke|curtain|curtains)\b",
    r"\b(between|on|to|in) (breasts|breast|thighs|pectorals)$", r"^(hand|hands) (in|under) (panties|bra|shirt|"
    r"clothes|skirt|swimsuit|leotard|pants)", r"^sitting on face$", r"^licking (armpit|foot|feet|nipple)",
    r"^(covering|cupping) (one |own )?(breast|breasts|ass|crotch)$", r"\bhumping\b", r"spreader bar",
    r"^glory wall$", r"^looking at (breasts|ass|crotch)$", r"^mole on (ass|breast|crotch)$",
    r"\b(public nudity|grinding|prone bone|gaping|orgy|clitoral|urethra|phimosis|cervix|impregnation)\b",
    r"\b(tribadism|molestation|spanked|spanking|stripper|child on child|have to pee|magic wand|asphyxiation)\b",
    r"\b(strangling|wide spread legs|futa with)\b",
    r"^(grabbing|spread|spreading|hand on|hands on|touching|licking|sucking|fondling|groping|grabbing from behind) "
    r"(own |another's )?(ass|anus|breast|breasts|crotch|groin|pussy|penis|nipples?|butt)$",
)

# 정확히 일치하는 예외 (규칙이 헷갈리기 쉬운 것)
EXACT = {}
for _group, _items in {
    "count": "solo, solo focus, multiple girls, multiple boys, multiple others, no humans, male focus, "
             "female focus, couple, everyone, group picture, 6+girls, 6+boys, 6+others",
    "appearance": "hair between eyes, eyes visible through hair, eyebrows hidden by hair, "
                  "eyebrows visible through hair, eyebrows behind hair, sharp teeth, fang, fangs, skin fang, "
                  "fang out, tan, tanlines, one-piece tan, bikini tan, elf, dark elf, oni, kemonomimi mode, "
                  "animal ear fluff, extra ears, head wings, head fins, androgynous, petite, curvy, plump, fat, "
                  "skinny, muscular, muscular female, muscular male, toned, toned male, abs, pectorals, "
                  "large pectorals, biceps, thick thighs, thighs, wide hips, narrow waist, long legs, collarbone, "
                  "ribs, thigh gap, flat chest, tall, tall female, tall male, short, mature female, mature male, "
                  "old, old man, old woman, child, female child, male child, aged down, aged up, teenage, "
                  "baby, ahoge, sidelocks, bangs, blunt bangs, swept bangs, parted bangs, crossed bangs, "
                  "asymmetrical bangs, short bangs, braid, braids, twin braids, side braid, single braid, "
                  "french braid, crown braid, braided ponytail, braided bangs, ponytail, side ponytail, "
                  "high ponytail, low ponytail, short ponytail, folded ponytail, twintails, low twintails, "
                  "short twintails, two side up, one side up, half updo, updo, bob cut, hime cut, pixie cut, "
                  "buzz cut, undercut, mohawk, afro, ringlets, drill hair, twin drills, dreadlocks, bald, "
                  "forehead, widow's peak, sideburns, beard, mustache, stubble, goatee, facial hair, "
                  "heterochromia, tsurime, tareme, sanpaku, eyelashes, colored eyelashes, eyeliner, eyeshadow, "
                  "mascara, makeup, lipstick, lips, pink lips, red lips, freckles, mole, scar, tattoo, "
                  "facial mark, forehead mark, whisker markings, body markings, dot nose, halo, horns, "
                  "pointy ears, animal ears, tail, wings, claws, fingernails, long fingernails, toenails, "
                  "nail polish, dark skin, pale skin, colored skin, white skin, robot joints, doll joints, "
                  "mechanical arms, prosthesis, third eye, slit pupils, bright pupils, colored sclera, "
                  "black sclera, mole under eye, mole under mouth, scar on face, scar across eye, veins, "
                  "bandaid, bandages, bandaged arm, bandaged leg, bandaid on face, injury, blood on face, "
                  "cat girl, fox girl, dog girl, wolf girl, rabbit girl, horse girl, dragon girl, demon girl, "
                  "monster girl, angel, demon, vampire, mermaid, lamia, harpy, centaur, slime girl, android, "
                  "cyborg, furry, furry female, furry male, animal nose, snout, gradient hair, streaked hair, "
                  "multicolored hair, two-tone hair, colored inner hair, split-color hair, hair intakes, "
                  "hair flaps, hair rings, hair bun, double bun, single hair bun, hair up, hair down",
    "outfit": "glasses, eyewear, sunglasses, round eyewear, semi-rimless eyewear, rimless eyewear, "
              "black-framed eyewear, red-framed eyewear, blue-framed eyewear, under-rim eyewear, "
              "over-rim eyewear, eyewear on head, bespectacled, monocle, goggles, goggles on head, eyepatch, "
              "blindfold, fake animal ears, fake tail, fake horns, animal hood, ear piercing, earrings, "
              "wing collar, horned headwear, cat ear headphones, mouth mask, surgical mask, tress ribbon, "
              "barefoot, no shoes, no headwear, navel, midriff, midriff peek, stomach, bare shoulders, "
              "bare arms, bare legs, bare back, cleavage, sideboob, underboob, zettai ryouiki, "
              "skindentation, strap gap, covered navel, maid, waitress, nurse, miko, nun, witch, "
              "magical girl, playboy bunny, cheerleader, idol, school uniform, gym uniform, buruma, "
              "sailor, military, formal, casual, enmaided, kimono, yukata, hakama, obi, sash, "
              "japanese clothes, chinese clothes, china dress, see-through, frills, lace, lace trim, "
              "ribbon trim, fur trim, gold trim, buttons, zipper, pocket, breast pocket, drawstring, "
              "plaid, polka dot, argyle, gingham, houndstooth, sleeveless, strapless, halterneck, "
              "off shoulder, highleg, backless outfit, clothing cutout, cleavage cutout, o-ring, "
              "buckle, belt buckle, chain, bell, jingle bell, neck bell, jewelry, gem, ring, wedding ring, "
              "school bag, bag, backpack, handbag, shoulder bag, pouch, satchel, randoseru, watch, "
              "wristwatch, headphones, headset, earphones, tiara, crown, circlet, veil, skin tight, "
              "fur collar, wet clothes, shirt overhang, sweater vest, military uniform, sailor collar",
    "expression": "closed eyes, one eye closed, half-closed eyes, wide-eyed, empty eyes, sparkling eyes, "
                  "rolling eyes, crazy eyes, tearing up, crying with eyes open, heart-shaped pupils, "
                  "constricted pupils, v-shaped eyebrows, raised eyebrow, raised eyebrows, furrowed brow, "
                  "jitome, blush stickers, shaded face, anger vein, sweatdrop, flying sweatdrops, "
                  "nervous sweating, :d, :o, :3, ;d, :t, :p, :q, :<, :>, ;), :/, :|, d:, 3:, o3o, xd, ;o, ;p, "
                  ";q, :i, ;3, :x, c:, >o<, ;(, >:), >:(, :), :(, =), =d, ^^^, "
                  "expressionless, light smile, naughty face, seductive smile, evil smile, wavy mouth, "
                  "triangle mouth, open mouth, closed mouth, parted lips, teeth, upper teeth only, "
                  "lower teeth only, clenched teeth, tongue, tongue out, licking lips, drooling, trembling, "
                  "heavy breathing, glaring, blank stare, smug, wink, nose blush, ear blush, full-face blush, "
                  "lip biting, biting own lip, puckered lips, pursed lips, light frown, raised eyebrow",
    "pose": "standing, sitting, kneeling, lying, squatting, crouching, leaning forward, leaning back, "
            "leaning to the side, bent over, walking, running, jumping, flying, floating, falling, "
            "contrapposto, t-pose, a-pose, outstretched arms, outstretched arm, outstretched hand, "
            "spread arms, spread legs, crossed arms, crossed legs, crossed ankles, v, double v, w, "
            "peace sign, thumbs up, salute, pointing, pointing at viewer, waving, beckoning, shushing, "
            "paw pose, heart hands, ok sign, fox shadow puppet, \\m/, \\o/, \\n/, v arms, x arms, "
            "own hands together, own hands clasped, hands together, interlocked fingers, clenched hand, "
            "clenched hands, fist, open hand, reaching, reaching towards viewer, stretching, "
            "yokozuwari, seiza, wariza, indian style, on side, on back, on stomach, on one knee, all fours, "
            "standing on one leg, fighting stance, battle stance, dynamic pose, head tilt, head rest, "
            "head down, head back, eye contact, facing viewer, facing away, facing another, turning around, "
            "hug, hug from behind, holding hands, princess carry, piggyback, lap pillow, headpat, kiss, "
            "eating, drinking, mouth hold, sleeping, reading, singing, dancing, selfie, taking picture, "
            "wading, swimming, bathing, partially submerged, arm support, arms up, arm up, hands up, hand up",
    "composition": "full body, upper body, lower body, cowboy shot, portrait, close-up, profile, back, "
                   "straight-on, dutch angle, pov, foreshortening, perspective, fisheye, wide shot, "
                   "very wide shot, sideways, upside-down, split screen, face, centered, symmetry, "
                   "vanishing point, depth of field, blurry foreground, inset, cropped, out of frame",
    "background": "outdoors, indoors, scenery, day, night, evening, morning, sunset, sunrise, twilight, dusk, "
                  "dawn, sky, cloud, sun, moon, full moon, crescent moon, starry sky, night sky, rain, snow, "
                  "snowing, fog, water, ocean, beach, sand, tree, nature, grass, forest, flower, petals, "
                  "cherry blossoms, people, crowd, sunlight, moonlight, light rays, sunbeam, backlighting, "
                  "rim lighting, lens flare, shadow, dappled sunlight, bokeh, reflection, window, curtains",
    "other": "monochrome, greyscale, spot color, limited palette, chibi, mini person, minigirl, yuri, yaoi, "
             "hetero, genderswap, otoko no ko, crossdressing, alternate costume, official alternate costume, "
             "adapted costume, alternate hairstyle, cosplay, faceless, faceless male, sweat, wet, steam, "
             "breath, blood, glowing, sparkle, heart, armpits, armpit crease, feet, toes, soles, legs, ass, "
             "floating hair, hair blowing, wind, motion lines, motion blur, emphasis lines, blurry, "
             "shiny skin, shiny clothes, height difference, age difference, size difference, "
             "swim ring, innertube, star (symbol), musical note, crescent, ?, !, !?, ..., "
             "drinking glass, drinking straw, playing card, sleeping bag, bow (weapon), bow (music), "
             "hand fan, paper fan, folding fan, holding (nothing), 39, x",
}.items():
    for _t in _words(_items):
        EXACT.setdefault(_t, _group)

# 실제 태거 결과를 보며 고친 예외 (위 목록과 겹치면 위 목록이 우선)
for _group, _items in {
    "appearance": "hand tattoo, single mechanical arm, prosthetic arm, amputee, kyuubi, arthropod girl, "
                  "median furrow, teardrop facial mark, teardrop tattoo, stitched mouth, alternate breast size, toenail polish, sharp fingernails, fins, facepaint, bodypaint, "
                  "body writing, whiskers, cowlick, pompadour, topknot, single sidelock, colored tips, blunt ends, "
                  "hairpods, albino, talons, beak, animal feet, winged arms, extra arms, joints, linea alba, "
                  "shoulder blades, belly, big belly, chest jewel, one-eyed, taur, antlers, reindeer antlers, "
                  "kitsune, nekomata, jiangshi, zombie, fairy, giant, giantess, draph, erune, miqo'te, au ra, "
                  "bruise, cuts, stitches, bleeding, freckles, burn scar, bandaid on leg, bandaid on knee, "
                  "bandaid on cheek, bandaid on nose, bandaged hand, bandaged head, mechanical parts, glowing eyes",
    "outfit": "diving mask, diving suit, diving mask on head, hand wraps, school emblem, school briefcase, "
              "athletic leotard, ear protection, nose ring, chin strap, wing brooch, breast cutout, ear tag, "
              "animal ear legwear, cat ear legwear, cat ear panties, tail ring, horn ring, spacesuit, "
              "single bare shoulder, pince-nez, hip vent, camouflage, cable knit, police, fur coat, fur scarf, "
              "fur cape, fur cloak, fur jacket, fur boots, fur cuffs, fur hat, "
              "bun cover, ear covers, office lady, clothes around waist, jacket around waist, "
              "sweater around waist, shirt around waist, necktie between breasts, multiple hair bows, flower knot, "
              "shopping bag, headgear, scrunchie, thighhigh, single thighhigh, single kneehigh, single sock, "
              "side slit, bandana, beanie, bandeau, underbust, double-breasted, gakuran, tabi, microskirt, "
              "arm warmers, leg warmers, petticoat, bodystocking, habit, lowleg, center opening, topless male, "
              "unzipped, partially unzipped, open fly, undershirt, waistcoat, cutoffs, male swimwear, "
              "swim trunks, babydoll, sarong, dougi, kariginu, tasuki, hachimaki, muneate, obijime, obiage, "
              "sode, kote, tate eboshi, nightcap, fedora, aiguillette, dog tags, bangle, thighlet, holster, "
              "thigh holster, knee pads, elbow pads, arm guards, shoulder pads, feather boa, coattails, "
              "kanzashi, head wreath, earclip, earpiece, crescent pin, race queen, goth fashion, id card, "
              "power armor, mecha musume, red scrunchie, blue scrunchie, white scrunchie, black scrunchie, "
              "wrist scrunchie, hair scrunchie, emblem",
    "expression": "averting eyes, narrowed eyes, unusually open eyes, bloodshot eyes, holding breath, "
                  "talking, staring, thinking, scowl, gloom (expression), turn pale, sideways glance, "
                  "food in mouth, blood from mouth, body blush",
    "pose": "double fox shadow puppet, pillow grab, watching television, lap pillow invitation, submerged, "
            "skirt hold, covered mouth, hair tucking, hair twirling, hair flip, hair pull, invisible chair, "
            "pillow hug, straddling, upright straddle, between legs, leg lift, arched back, back-to-back, "
            "face-to-face, cheek-to-cheek, side-by-side, heads together, arm hug, locked arms, "
            "steepled fingers, between fingers, pigeon-toed, tiptoes, reclining, twisted torso, midair, "
            "afloat, soaking feet, toe scrunch, poking, pouring, bubble blowing, broom riding, waking up, "
            "middle finger, pinky out, w arms, open hands, unsheathing, reverse grip, under covers, "
            "splashing, imminent kiss, french kiss, kissing cheek, arms under breasts, arm under breasts, "
            "fighting, battle, duel, firing, trigger discipline, finger on trigger, standing split",
    "background": "washing machine, hanging light, hanging plant, shopping cart, "
                  "falling petals, falling leaves, shooting star, falling feathers, falling star, floating island, "
                  "fireworks, waves, ripples, constellation, contrail, house, kotatsu, toilet, armchair, stool, "
                  "cushion, trash can, flight deck, cage, puddle, light rays",
    "other": "riding crop, drawing tablet, cooking pot, hand puppet, hand mirror, hand net, flying fish, "
             "smoking gun, princess, excalibur (fate/stay night), kitchen knife, chocolate bar, watermelon bar, "
             "bamboo broom, paper airplane, e.g.o (project moon), fourth wall, yes-no pillow, pool of blood, "
             "lipstick tube, hair brush, hair dryer, makeup brush, japari bun, eye of horus, "
             "cleft of venus, interracial, kneepits, disembodied limb, "
             "water bottle, water gun, infection monitor (arknights), drop shadow, lightning bolt symbol, "
             "unmoving pattern, mobile suit, painting (medium), painting (object), costume switch, "
             "abyssal ship, jack-o'-lantern, official alternate hairstyle, official alternate hair length, "
             "leaf on head, frilled pillow, two-sided fabric, tomboy, bishounen, manly, pregnant",
    "meta": "partially visible vulva, clitoris, groping, top-down bottom-up, futa with female, "
            "reverse suspended congress, peeing self, partially undressed, backboob, against glass, food on body, "
            "between thighs, clothes between breasts, clothes between thighs, guided breast grab, "
            "chocolate on breasts, food on breasts, head between breasts, arm between breasts, veiny breasts, "
            "one breast out, bursting breasts, framed breasts, unaligned breasts, breast curtains, hanging breasts, "
            "huge ass, pantylines, panty peek, m legs, symmetrical docking, asymmetrical docking, cross-section, "
            "x-ray, bad anatomy, artistic error, sample watermark, collage, silent comic, fake screenshot, "
            "content rating, thank you, wind lift, pulled by self, presenting armpit, condom in mouth, "
            "hand under clothes, grabbing own breast, grabbing own ass, grabbing another's ass, spread anus, "
            "spread ass, slave, sheet grab, torso grab, thigh grab, stomach bulge, virgin killer sweater, "
            "slingshot swimsuit, eyepatch bikini, reverse bunnysuit, reverse outfit, wardrobe malfunction, "
            "see-through silhouette, wet panties, bra visible through clothes, assisted exposure, "
            "imminent penetration, chibi inset, engrish text, gameplay mechanics, health bar",
}.items():
    for _t in _words(_items):
        EXACT.setdefault(_t, _group)

for _t in META_EXACT | SENSITIVE_EXACT:
    EXACT[_t] = "meta"
for _t in EMOTICONS:
    EXACT.setdefault(_t, "expression")
del _group, _items, _t

# 정규식 규칙 (위에서부터 우선)
_C = r"(?:red|blue|green|yellow|orange|purple|pink|brown|black|white|grey|gray|silver|gold|golden|aqua|" \
     r"light blue|light brown|light purple|light green|dark blue|dark green|dark red|blonde|platinum blonde|" \
     r"multicolored|two-tone|gradient|rainbow|beige|cyan|magenta|violet|lavender|teal|navy blue|maroon)"
_SMALL_ACC = r"(?:ribbon|ribbons|bow|bows|bowtie|ornament|ornaments|flower|flowers|band|tie|ties|bobbles|beads|" \
             r"bell|bells|clip|clips|pin|pins|stick|sticks|scrunchie|scrunchies|tubes|cuffs|bun cover|bauble)"
_BODY = r"(?:hand|hands|arm|arms|finger|fingers|index finger|thumb|thumbs|leg|legs|knee|knees|elbow|elbows|" \
        r"foot|feet|head|own hands)"
_VERBS = r"(?:holding|carrying|hugging|grabbing|pulling|pushing|touching|covering|adjusting|playing|fighting|" \
         r"kicking|punching|swinging|aiming|shooting|throwing|catching|riding|driving|kissing|licking|biting|" \
         r"blowing|looking|facing|turning|peeking|hiding|resting|posing|praying|saluting|clapping|crossing|" \
         r"spreading|lifting|tying|tucking|wiping|putting on|taking off|sharing|feeding|leaning|sitting|" \
         r"standing|lying|kneeling|squatting|crouching|walking|running|jumping|reaching|pointing|waving|" \
         r"stretching|eating|drinking|reading|writing|cooking|cleaning|sleeping|dancing|singing|bowing|" \
         r"sweeping|showering|smelling|sniffing|tickling|patting|petting|cupping|clenching|brushing|combing|" \
         r"braiding|fixing|tugging|arranging|unbuttoning|buttoning|dressing|bathing|washing|drying|wringing|" \
         r"squeezing|picking|offering|giving|receiving|sharing|smoking|texting|typing|drawing|painting|" \
         r"studying|shopping|climbing|floating|flying|falling|swimming|diving|wading|skating|skiing|" \
         r"hanging|carried|held|lifted|piggyback|rubbing|shading|stroking|applying|cutting|ruffling|" \
         r"watching|listening)"
RULES = (
    ("meta", META_RULES + SENSITIVE_RULES),
    ("count", (r"^(\d+|6\+)(girl|boy|other)s?$",)),
    # 배경색·무늬 배경·바닥/벽 (무늬 = 의상 규칙보다 먼저: "striped background", "checkered floor")
    ("background", (r"\bbackground$", r"^[\w'-]+ (floor|wall|walls|ceiling|sky|tiles)$")),
    # 구도 (자세 규칙보다 먼저: "head out of frame", "feet out of frame")
    ("composition", (
        r"^(full|upper|lower) body$", r"\bcowboy shot\b", r"\bclose-up\b", r"out of frame$",
        r"^cropped (torso|legs|arms|shoulders|head|body|feet)$",
        r"^from (side|behind|above|below|front|outside|inside|the side|the front|the back|afar)$",
        r"^(dutch|low|high) angle$", r"^pov\b", r"\bpov$", r" focus$", r"\b(wide|long|medium|full) shot$",
        r"\b(panorama|aerial view|bird's-eye view|worm's-eye view)\b",
    )),
    # 자세·동작·시선 (외형·의상 규칙보다 먼저: "hand in own hair", "adjusting eyewear", "covering mouth")
    ("pose", (
        rf"^{_BODY} (up|down|on|in|over|under|behind|between|to|at|together|apart|crossed|raised|out|around|"
        r"support|rest|lock|grab|grabbing|holding|across|near|from|against|outstretched|forward|back)\b",
        rf"^{_VERBS}\b(?! \()", rf"^(own )?{_BODY} (up|down)$",
        r"^(on|against|in|under|behind|between|over|sitting on|lying on|standing on) (chair|bed|couch|sofa|"
        r"floor|ground|stomach|back|side|lap|desk|table|bench|wall|water|knees|one knee|stairs|grass|swing|"
        r"shoulder|shoulders|person|another|tree|railing|rock|lap)\b",
        r" grab$",
        r"\b(pose|stance)$", r"^crossed (arms|legs|ankles)$", r"^(outstretched|spread) ", r" carry$",
        r"\bv over\b", r"^(hand|hands|finger|fingers) ", r"^(arm|arms|leg|legs) (behind|between|lock|up)\b",
    )),
    # 머리·귀·꼬리에 다는 장신구, 모자·안경·무늬 → 의상 (뒤의 '머리카락·눈 = 외형' 규칙보다 먼저)
    ("outfit", (
        rf"\b(hair|tail|ear|horn|wing|head|neck|leg|arm|wrist|ankle|thigh|waist|back|sleeve|hat) {_SMALL_ACC}$",
        r"^(clothes|jacket|sweater|shirt|coat|towel|scarf|cardigan|hoodie|kimono|haori|cape|sweater vest|"
        r"blazer|necktie|bag|headphones|goggles|eyewear|mask|hat|hood) (around|on|over) ",
        r"\b(hair ornament|hairclip|hairband|hairpin|hair ribbon|hair bow|hair flower|hair tie|hair bobbles)\b",
        r"\b(hair beads|hair bell|hair stick|hair scrunchie|hair tubes|headband|headpiece|headdress)\b",
        r"\b(headwear|hat|hats|cap|beret|helmet|hood|hoodie|bonnet|tiara|crown|circlet|veil|earmuffs)\b",
        r"\b(eyewear|glasses|goggles|monocle|eyepatch|mask|blindfold|visor)\b",
        r"\b(print|prints|pattern|patterned|trim|trimmed|stripes?|striped|checkered|plaid|polka dot)\b",
        r"\bornament\b", r"^fake ", r"\b(piercing|earrings?|earphones|headphones|headset)\b",
    )),
    # 점·흉터·문신 (표정 규칙보다 먼저: "mole under mouth", "scar on mouth")
    ("appearance", (r"\b(mole|moles|scar|scars|tattoo|tattoos|facial mark|birthmark|freckles)\b",)),
    ("expression", (
        r"\b(smile|smiling|grin|grinning|smirk|laugh|laughing|pout|pouting|puffy cheeks|blush|blushing)\b",
        r"\b(tears|teardrop|crying|cry|sobbing|frown|frowning|angry|anger|annoyed|irritated|furious|sad)\b",
        r"\b(surprised|shocked|scared|afraid|frightened|terrified|worried|nervous|anxious|embarrassed|shy)\b",
        r"\b(confused|happy|excited|determined|serious|expressionless|sleepy|tired|bored|disgust|disgusted)\b",
        r"\b(disappointed|jealous|smug|naughty|seductive|evil|crazy|panicking|scream|screaming|shouting)\b",
        r"\b(yawning|sigh|sighing|sulking|pain|wince|wincing|gasp|gasping|drool|drooling|panting|glare)\b",
        r"\b(mouth|teeth|tongue|sweatdrop|sweating|wink|winking)\b", r"\bfacepalm\b",
    )),
    ("appearance", (
        r"\bhair\b", r"\b(eyes|eye|pupils|sclera|iris|irises|eyebrows|eyelashes|lips|nose)\b",
        r"\bbreasts?\b", r"\b(skin|skinned)\b", r"\bnails\b",
        r"\b(animal ears|ears|ear|tail|tails|horns?|wings?|halo|antennae|claws|scales|paws)\b",
        r"^(body|neck|chest|arm|leg|white|black|brown|grey|blue|red|pink|purple|green|orange|yellow|"
        r"two-tone|multicolored) (fur|hair)$",
        r"\b(braid|braids|braided|ponytail|twintails|bangs|bun|buns|drills|sidelocks|ahoge|mole|moles|"
        r"freckles|scar|scars|tattoo|tattoos|markings|makeup|lipstick|eyeshadow|eyeliner)\b",
        r"^(cat|fox|dog|wolf|rabbit|bunny|horse|dragon|demon|monster|slime|bird|cow|sheep|mouse|tiger|lion|"
        r"bear|squirrel|raccoon|deer|goat|shark|snake|fish|bat|frog|cyborg|android|robot|plant|ghost|"
        r"angel|harpy|centaur|lamia|elf|dark elf|bee|spider|insect|alien|zombie|undead|doll|kitsune|"
        r"tanuki|ram|owl|penguin|mermaid|orc|ogre|giant|tengu|kappa|yokai|sheep|goat|squid|octopus) "
        r"(girl|boy|ears|tail|wings|horns)s?$",
        r"^(muscular|toned|chubby|slim|slender|skinny|curvy|plump|petite|voluptuous|athletic) ",
        r"\b(abs|biceps|pectorals|thighs|hips|waist|collarbone|physique)$",
        r"\b(beard|mustache|stubble|goatee|sideburns|eyelid|dimples|wrinkles|forehead|chin)\b",
        r"^(bandaid|bandaids|bandage|bandages|bandaged|scar|scars|tattoo|mole|bruise) (on|over|across)\b",
        r"^bandaged ",
    )),
    ("outfit", (
        r"\b(shirt|shirts|t-shirt|blouse|skirt|skirts|miniskirt|dress|dresses|sundress|gown|uniform|uniforms)\b",
        r"\b(serafuku|sailor|collar|collared|neckerchief|necktie|tie|ties|bow|bows|bowtie|ribbon|ribbons)\b",
        r"\b(jacket|jackets|coat|coats|overcoat|labcoat|parka|hoodie|sweater|cardigan|vest|blazer|apron)\b",
        r"\b(kimono|yukata|hakama|obi|haori|happi|furisode|hanfu|qipao|cheongsam|china dress|ao dai|sari)\b",
        r"\b(pants|trousers|shorts|jeans|denim|leggings|pantyhose|tights|thighhighs|kneehighs|"
        r"over-kneehighs|socks|stockings|legwear|garter|garters|legband|thighband|thigh strap|leg ribbon)\b",
        r"\b(footwear|shoes|shoe|boots|boot|sandals|loafers|sneakers|heels|high heels|mary janes|slippers|"
        r"geta|zouri|okobo|flip-flops|pumps|uwabaki)\b",
        r"\b(gloves|glove|mittens|gauntlets|sleeves|sleeve|sleeveless|cuffs|wristband|wristbands|armband|"
        r"armbands|armlet|bracer|vambraces)\b",
        r"\b(choker|necklace|necklaces|earring|earrings|jewelry|bracelet|bracelets|brooch|pendant|amulet|"
        r"locket|anklet|ring|rings|gem|gemstone|charm)\b",
        r"\b(scarf|cape|capelet|cloak|shawl|stole|poncho|mantle|muffler|neck warmer)\b",
        r"\b(frills|frilled|frill|lace|lace-trimmed|buttons|button|zipper|pocket|pockets|drawstring|"
        r"belt|belts|suspenders|harness|strap|straps|strapless|spaghetti strap|halterneck|halter)\b",
        r"\b(swimsuit|swimsuits|bikini|leotard|bodysuit|plugsuit|unitard|underwear|panties|bra|camisole|"
        r"tank top|crop top|tube top|sports bra|corset|bustier|chemise|negligee|nightgown|pajamas|robe|"
        r"bathrobe|towel|sarashi|fundoshi|bloomers|buruma|wetsuit|rash guard|lingerie|thong|briefs|boxers)\b",
        r"\b(armor|armour|breastplate|pauldrons|shoulder armor|greaves|chainmail|faulds|tassets)\b",
        r"\b(overalls|jumpsuit|suit|tuxedo|costume|outfit|clothes|clothing|attire|sportswear|tracksuit|"
        r"epaulettes|badge|name tag|lanyard|bag|backpack|purse|wallet)\b",
        r"\b(cutout|see-through|revealing|impossible clothes|latex|leather|fishnets|mesh|"
        r"sheer|torn|unbuttoned|untucked|tucked in|overhang|layered|wardrobe malfunction)\b",
        r"\b(maid|waitress|nurse|miko|nun|witch|priest|priestess|butler|chef|policewoman|cheerleader|idol|"
        r"bride|wedding|bunny suit|playboy bunny|magical girl|santa|ninja|knight|pirate|kunoichi|"
        r"ojou-sama|shrine maiden|lolita fashion|gothic lolita|sweet lolita|gyaru|kogal)\b",
        r"\b(sash|tabard|loincloth|pelvic curtain|skirt set|high-waist|highleg|off-shoulder|off shoulder|"
        r"turtleneck|v-neck|tassel|tassels|pom pom|fur collar|lapels|necktie|bolo tie|jabot|ascot)\b",
        r"\b(tunic|earbuds|sleepwear|medal|flats|microdress|g-string|ruff|tailcoat|raincoat|overskirt|"
        r"belly chain|diadem|turban|spandex|fanny pack|tam o' shanter|sweatband|kappougi|chaps|pauldron|"
        r"insignia|enpera|hagoromo|plunging neckline|keychain|thigh pouch|patch|uniform)\b",
    )),
    ("background", (
        r"\bbackground\b",
        r"\b(sky|skies|cloud|clouds|cloudy|sunset|sunrise|twilight|dusk|dawn|night|nighttime|daytime|evening|"
        r"morning|afternoon|noon|moon|sun|starry|stars|galaxy|space|planet|aurora|rainbow|horizon)\b",
        r"\b(sunlight|moonlight|light rays|sunbeam|backlighting|rim lighting|lens flare|light particles|"
        r"lighting|shadow|shade|dappled|spotlight|light leaks)\b",
        r"\b(rain|raining|snow|snowing|snowflakes|fog|foggy|mist|storm|lightning|thunder|weather)\b",
        r"^(spring|summer|autumn|winter)( \(season\))?$", r"\b(autumn leaves|maple leaf|falling leaves)\b",
        r"\b(outdoors|indoors|scenery|landscape|cityscape|skyline|architecture|interior|exterior|ruins)\b",
        r"\b(classroom|school|hallway|corridor|cafe|cafeteria|restaurant|shop|store|street|city|town|"
        r"village|building|buildings|skyscraper|road|alley|park|playground|beach|ocean|sea|shore|coast|"
        r"water|sand|forest|woods|jungle|tree|trees|nature|grass|field|meadow|garden|mountain|mountains|"
        r"hill|hills|river|lake|pond|waterfall|pool|poolside|onsen|bathroom|bath|bathtub|bedroom|room|"
        r"kitchen|living room|office|library|shrine|torii|temple|castle|church|cathedral|palace|station|"
        r"train|bus|car|subway|airplane|ship|boat|rooftop|balcony|bridge|tower|stage|concert|festival|"
        r"desert|cave|island|underwater|gym|hospital|prison|dungeon|throne|locker room|shower|veranda|"
        r"porch|courtyard|street|sidewalk|crosswalk|parking lot|harbor|port|market|bar|izakaya|arcade)\b",
        r"\b(window|windows|curtains|door|doors|doorway|wall|walls|floor|ceiling|chandelier|lamp|lantern|"
        r"light bulb|lamppost|street lamp|streetlight|stairs|staircase|fence|railing|bench|table|desk|chair|"
        r"couch|sofa|bed|bed sheet|pillow|futon|blanket|shelf|bookshelf|cabinet|counter|chalkboard|"
        r"blackboard|whiteboard|menu board|sign|signboard|traffic light|utility pole|power lines|"
        r"vending machine|motor vehicle|ground vehicle|bicycle|truck|crowd|people|plant|plants|vase|"
        r"flower pot|carpet|rug|tatami|shoji|fusuma|sliding doors|column|pillar|statue|fountain|pier|"
        r"dock|lighthouse|tent|campfire|tiles|bricks|brick wall|stone wall|wooden wall|locker|"
        r"bookcase|wardrobe|mirror|clock|wall clock|television|monitor|computer|piano|bathtub|sink)\b",
        r"\b(flower|flowers|rose|roses|lily|tulip|sunflower|daisy|hydrangea|lotus|cherry blossoms|petals|"
        r"leaf|leaves|branch|branches|bush|vines|ivy|moss|bamboo|pine tree|palm tree|wisteria|hibiscus|"
        r"lily pad|lavender|carnation|morning glory|dandelion|clover|poppy|iris \(flower\)|camellia)\b",
    )),
)
_RULES = tuple((group, tuple(re.compile(p) for p in pats)) for group, pats in RULES)


def norm_tag(tag):
    """표시용 태그 표기: 밑줄 → 공백 (이모티콘 태그는 그대로)"""
    tag = str(tag).strip()
    return tag if tag in EMOTICONS else tag.replace("_", " ")


@functools.lru_cache(maxsize=None)
def _classify(t):
    g = EXACT.get(t)
    if g:
        return g
    for group, pats in _RULES:
        for p in pats:
            if p.search(t):
                return group
    return "other"


def classify(tag, kind="general"):
    """태그 → 그룹 id (GROUPS 중 하나). kind="character"면 항상 "character"."""
    if kind == "character":
        return "character"
    t = str(tag).strip().lower()
    if t not in EMOTICONS:
        t = t.replace("_", " ")
    return _classify(re.sub(r"\s+", " ", t))


def escape(tag):
    """ComfyUI 프롬프트용: 괄호를 \\( \\) 로 (가중치 문법 (tag:1.2) 과 충돌하지 않게). 이미 escape된 것은 그대로."""
    return re.sub(r"(?<!\\)([()])", r"\\\1", str(tag))


def to_prompt(tags):
    """태그 목록(문자열 또는 {"tag","group"} dict) → 그룹 순서대로 escape해서 ', '로 결합. 같은 그룹 안에서는 받은 순서 유지."""
    order = {g: i for i, g in enumerate(GROUPS)}
    items, seen = [], set()
    for i, t in enumerate(tags or []):
        if isinstance(t, dict):
            name = t.get("tag")
            group = t.get("group") or classify(name or "", t.get("kind") or "general")
        else:
            name, group = t, classify(t)
        name = str(name or "").strip()
        if not name or name in seen:
            continue
        seen.add(name)
        items.append((order.get(group, len(order)), i, name))
    items.sort()
    return ", ".join(escape(name) for _, _, name in items)


def group_list():
    """[{id, label}] 표시 순서"""
    return [{"id": g, "label": GROUP_LABELS[g]} for g in GROUPS]


# ====================================================================== 모델 목록
def _model_entry(d):
    try:
        if d.name.startswith(".") or not d.is_dir():
            return None
        onnx, tags = d / MODEL_FILE, d / TAGS_FILE
        if not (onnx.is_file() and tags.is_file()):
            return None
        return {"name": d.name, "path": str(d), "size": onnx.stat().st_size}
    except OSError:
        return None


def list_models():
    """설치된 태거 [{name, path, size}] — config.model_dirs("tagger") 아래 두 파일이 다 있는 하위 폴더 (앞쪽 경로 우선)"""
    found = {}
    for root in config.model_dirs("tagger"):
        try:
            subs = sorted(root.iterdir(), key=lambda p: p.name.lower())
        except OSError:
            continue
        for d in subs:
            m = _model_entry(d)
            if m and m["name"] not in found:
                found[m["name"]] = m
    return list(found.values())


def find_model(name):
    if not isinstance(name, str) or not name or "/" in name or "\\" in name or name.startswith("."):
        return None
    for m in list_models():
        if m["name"] == name:
            return m
    return None


def default_name(preferred=None):
    """쓸 모델 이름: preferred(설정값)가 설치돼 있으면 그것, 아니면 DEFAULT_MODEL, 아니면 설치된 첫 모델, 없으면 None"""
    names = [m["name"] for m in list_models()]
    for n in (preferred, DEFAULT_MODEL):
        if n and n in names:
            return n
    return names[0] if names else None


def no_model_message():
    dirs = config.model_dirs("tagger")
    where = dirs[0] if dirs else config.MODEL_ROOTS[0] / "tagger"
    return ("프롬프트 추출용 태거 모델이 설치되어 있지 않습니다. "
            f"{where}/<모델 이름>/ 폴더에 {MODEL_FILE}과 {TAGS_FILE}을 넣으세요 "
            f"(권장: {DEFAULT_MODEL}). {HELP_HINT}")


# ====================================================================== 런타임
_runtime = {"checked": False, "error": None}
_runtime_lock = threading.Lock()


def runtime_error():
    """numpy/Pillow/onnxruntime을 쓸 수 있으면 None, 아니면 한국어 안내문 (한 번만 검사)"""
    with _runtime_lock:
        if not _runtime["checked"]:
            missing = []
            for mod in ("numpy", "PIL", "onnxruntime"):
                try:
                    __import__(mod)
                except Exception:  # ImportError 외에 네이티브 라이브러리 로드 실패도 있음
                    missing.append({"PIL": "Pillow"}.get(mod, mod))
            if missing:
                _runtime["error"] = (
                    f"이 Python에는 {', '.join(missing)}이(가) 없어 프롬프트 추출을 쓸 수 없습니다. "
                    f"엔진 Python({config.ENGINE_PYTHON})으로 실행하세요. {HELP_HINT}")
            _runtime["checked"] = True
        return _runtime["error"]


def runtime_available():
    return runtime_error() is None


def _require_runtime():
    err = runtime_error()
    if err:
        raise TaggerError(err, "unavailable")


def _read_tags(path):
    """selected_tags.csv → (이름 목록, category 목록)"""
    names, cats = [], []
    try:
        with open(path, encoding="utf-8", newline="") as f:
            reader = csv.DictReader(f)
            if not reader.fieldnames or "name" not in reader.fieldnames or "category" not in reader.fieldnames:
                raise TaggerError(f"{TAGS_FILE} 형식이 올바르지 않습니다 (name, category 열이 필요): {path}", "unavailable")
            for row in reader:
                names.append(row.get("name") or "")
                try:
                    cats.append(int(row.get("category") or 0))
                except ValueError:
                    cats.append(-1)
    except OSError as e:
        raise TaggerError(f"태그 목록 파일을 읽을 수 없습니다: {path} ({e.strerror or e})", "unavailable") from None
    except (UnicodeDecodeError, csv.Error) as e:
        raise TaggerError(f"{TAGS_FILE} 파일이 손상되었습니다: {path} ({e})", "unavailable") from None
    if not names:
        raise TaggerError(f"{TAGS_FILE}에 태그가 없습니다: {path}", "unavailable")
    return names, cats


class Tagger:
    """WD 태거 v3 계열 (입력 NHWC BGR 0~255, 출력 시그모이드 확률). 생성은 get()으로."""

    def __init__(self, name, path):
        _require_runtime()
        import numpy as np
        import onnxruntime as ort

        self.name = name
        self.dir = Path(path)
        t0 = time.time()
        names, cats = _read_tags(self.dir / TAGS_FILE)
        try:
            opts = ort.SessionOptions()
            opts.log_severity_level = 3  # 경고 로그 숨김
            self.session = ort.InferenceSession(str(self.dir / MODEL_FILE), sess_options=opts,
                                                providers=["CPUExecutionProvider"])
        except Exception as e:
            raise TaggerError(f"태거 모델({name})을 불러오지 못했습니다. 파일이 손상되었거나 다른 형식일 수 있습니다: "
                              f"{e.__class__.__name__}: {str(e)[:300]}", "unavailable") from None
        inp = self.session.get_inputs()[0]
        shape = list(inp.shape)
        if len(shape) != 4 or shape[3] != 3:
            raise TaggerError(f"지원하지 않는 태거 형식입니다({name}): 입력 모양 {shape} (NHWC 3채널 필요)", "unavailable")
        self.size = shape[1] if isinstance(shape[1], int) and shape[1] > 0 else DEFAULT_SIZE
        self.input_name = inp.name
        out = self.session.get_outputs()[0]
        self.output_name = out.name
        n_out = out.shape[-1] if out.shape and isinstance(out.shape[-1], int) else None
        if n_out is not None and n_out != len(names):
            raise TaggerError(f"태거 모델({name})의 출력 개수({n_out})와 {TAGS_FILE}의 태그 수({len(names)})가 다릅니다",
                              "unavailable")
        self.names = [norm_tag(n) for n in names]
        cats = np.asarray(cats)
        self.rating_idx = [i for i in np.nonzero(cats == 9)[0] if names[i] in RATINGS] or list(np.nonzero(cats == 9)[0])
        self.general_mask = cats == 0
        self.char_mask = cats == 4
        self.load_seconds = time.time() - t0

    # ------------------------------------------------------------------ 전처리
    def prepare(self, image):
        """PIL 이미지 → (float32 [1, S, S, 3] BGR 0~255, (w, h)).

        EXIF 회전 보정 → 투명/팔레트는 흰 배경에 합성 → RGB → 긴 변 기준 흰색 정사각 패딩(가운데) → S×S BICUBIC.
        (w, h)는 회전 보정 후 원본 크기. 긴 변이 PAD_MAX를 넘는 직사각형은 패딩 전에 먼저 줄인다
        (세로로 긴 웹툰 캡처 등에서 max(w, h)² 캔버스가 수 GB가 되지 않게).
        """
        import numpy as np
        from PIL import Image, ImageOps

        try:
            im = ImageOps.exif_transpose(image)
        except Exception:  # 손상된 EXIF: exif_transpose가 EXIF를 다시 쓰다 struct.error 등 → 회전만 직접 적용
            try:
                o = image.getexif().get(0x0112, 1)
            except Exception:
                o = 1
            T = Image.Transpose
            m = {2: T.FLIP_LEFT_RIGHT, 3: T.ROTATE_180, 4: T.FLIP_TOP_BOTTOM, 5: T.TRANSPOSE,
                 6: T.ROTATE_270, 7: T.TRANSVERSE, 8: T.ROTATE_90}.get(o) if isinstance(o, int) else None
            im = image.transpose(m) if m is not None else image
        if im.mode.startswith("I;16") or im.mode in ("I", "F"):  # 16비트·부동소수 흑백 PNG/TIFF → 8비트
            a = np.asarray(im.convert("F") if im.mode != "F" else im, dtype=np.float32)
            peak = float(a.max()) if a.size else 0.0
            a = a * (255.0 / 65535.0) if peak > 255 else a
            im = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "L")
        if im.mode in ("RGBA", "LA", "PA", "RGBa", "La") or "transparency" in im.info:
            im = im.convert("RGBA")
            bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
            bg.alpha_composite(im)
            im = bg
        im = im.convert("RGB")
        w, h = im.size
        side = max(w, h)
        if w != h and side > PAD_MAX:
            k = PAD_MAX / side
            im = im.resize((max(1, round(w * k)), max(1, round(h * k))), Image.Resampling.BICUBIC, reducing_gap=3.0)
            side = max(im.size)
        if im.width != im.height:
            canvas = Image.new("RGB", (side, side), (255, 255, 255))
            canvas.paste(im, ((side - im.width) // 2, (side - im.height) // 2))
            im = canvas
        if side != self.size:
            im = im.resize((self.size, self.size), Image.Resampling.BICUBIC)
        arr = np.asarray(im, dtype=np.float32)[:, :, ::-1]  # RGB → BGR
        return np.ascontiguousarray(arr[None]), (w, h)

    # ------------------------------------------------------------------ 추론
    def predict(self, image):
        """→ {"rating": {general, sensitive, questionable, explicit}, "tags": [{tag, score, kind, group}], "size": [w, h]}

        일반 태그는 점수 FLOOR(0.15) 이상, 캐릭터 태그는 CHAR_FLOOR(0.5) 이상만, 점수 내림차순.
        """
        import numpy as np

        try:
            x, size = self.prepare(image)
        except (OSError, ValueError) as e:
            raise TaggerError(f"이미지를 처리할 수 없습니다: {e}", "image") from None
        except MemoryError:
            raise TaggerError("이미지를 처리할 메모리가 부족합니다. 더 작은 이미지로 다시 시도하세요.", "image") from None
        except Exception as e:  # Pillow 내부 예외 (손상된 메타데이터 등)
            raise TaggerError(f"이미지를 처리할 수 없습니다. 파일이 손상되었을 수 있습니다 ({e.__class__.__name__})",
                              "image") from None
        try:
            probs = self.session.run([self.output_name], {self.input_name: x})[0][0]
        except Exception as e:
            raise TaggerError(f"태그 추출 중 오류가 발생했습니다: {e.__class__.__name__}: {str(e)[:300]}") from None
        probs = np.asarray(probs, dtype=np.float32)
        rating = {self.names[i]: round(float(probs[i]), 4) for i in self.rating_idx}
        for r in RATINGS:
            rating.setdefault(r, 0.0)
        tags = []
        for i in np.nonzero(self.general_mask & (probs >= FLOOR))[0]:
            tags.append({"tag": self.names[i], "score": round(float(probs[i]), 4), "kind": "general",
                         "group": classify(self.names[i])})
        for i in np.nonzero(self.char_mask & (probs >= CHAR_FLOOR))[0]:
            tags.append({"tag": self.names[i], "score": round(float(probs[i]), 4), "kind": "character",
                         "group": "character"})
        tags.sort(key=lambda t: -t["score"])
        return {"rating": rating, "tags": tags, "size": [int(size[0]), int(size[1])]}


# ====================================================================== 캐시
_cache = {}
_cache_lock = threading.Lock()  # _cache·_load_locks 읽기/쓰기에만 잠깐 잡는다 (로드 중에도 loaded()가 바로 답하게)
_load_locks = {}                # 모델 이름별 로드 lock: 같은 모델을 동시에 요청해도 한 번만 불러옴


def get(name=None):
    """이름별로 한 번만 불러오는 Tagger (스레드 안전). name=None이면 default_name()."""
    _require_runtime()
    if name is None:
        name = default_name()
        if name is None:
            raise TaggerError(no_model_message(), "unavailable")
    with _cache_lock:
        t = _cache.get(name)
    if t is not None:
        return t
    m = find_model(name)
    if m is None:
        installed = [x["name"] for x in list_models()]
        if not installed:
            raise TaggerError(no_model_message(), "unavailable")
        raise TaggerError(f"태거 모델을 찾을 수 없습니다: {name} (설치된 모델: {', '.join(installed)})", "not_found")
    with _cache_lock:
        load_lock = _load_locks.setdefault(name, threading.Lock())  # 설치된 이름만 → 개수가 한정됨
    with load_lock:
        with _cache_lock:
            t = _cache.get(name)
        if t is None:
            t = Tagger(name, m["path"])  # 수 초~수십 초 (_cache_lock 없이)
            with _cache_lock:
                _cache[name] = t
        return t


def loaded():
    """지금 메모리에 올라와 있는 모델 이름 목록 (불러오는 중인 모델은 아직 없음)"""
    with _cache_lock:
        return list(_cache)


def unload_all():
    with _cache_lock:
        names = list(_cache)
        _cache.clear()
    if names:
        import gc
        gc.collect()
    return names


# ====================================================================== 이미지 열기
def open_image(src):
    """경로 또는 bytes → 디코딩까지 끝난 PIL 이미지 (애니메이션은 첫 프레임). 실패 시 TaggerError(kind="image")."""
    _require_runtime()
    import io
    from PIL import Image

    if isinstance(src, (bytes, bytearray, memoryview)):
        fp, label = io.BytesIO(bytes(src)), "업로드한 파일"
    else:
        p = Path(src)
        if not p.is_file():
            raise TaggerError(f"파일을 찾을 수 없습니다: {src}", "image")
        fp, label = p, p.name
    bad = f"이미지를 읽을 수 없습니다 ({label}). PNG·JPG·WEBP·GIF·BMP 이미지 파일인지 확인하세요."
    try:
        im = Image.open(fp)
        w, h = im.size
        if w * h > MAX_PIXELS:
            im.close()
            raise TaggerError(f"이미지가 너무 큽니다 ({w}×{h}, 최대 {MAX_PIXELS // 10_000}만 화소). "
                              "크기를 줄여서 다시 시도하세요.", "image")
        if w < 1 or h < 1:
            raise TaggerError(bad, "image")
        im.load()
        return im
    except TaggerError:
        raise
    except Image.DecompressionBombError:
        raise TaggerError("이미지가 너무 큽니다 (화소 수 제한 초과). 크기를 줄여서 다시 시도하세요.", "image") from None
    except (OSError, ValueError, SyntaxError, EOFError, IndexError, TypeError, KeyError, MemoryError):
        raise TaggerError(bad, "image") from None
    except Exception:  # Pillow 플러그인이 던지는 기타 예외 (손상된 파일)
        raise TaggerError(bad, "image") from None


def predict_file(path, name=None):
    """파일 하나 태깅 → predict() 결과 + {"model", "path"}"""
    t = get(name)
    im = open_image(path)
    try:
        res = t.predict(im)
    finally:
        im.close()
    res["model"] = t.name
    res["path"] = str(path)
    return res
