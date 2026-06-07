#import "/.inkycap/notebox.typ": *
#set text(lang: "fr", region: "CA")

#note(
  title: "Vue mycélienne",
  description: "La Vue mycélienne est une carte interactive de votre boîte de notes qui fait remonter les liens latents et les concepts émergents, révélant l'endroit où vos connaissances veulent croître ensuite.",
  tags: ("documentation",),
)

= Vue mycélienne

La *Vue mycélienne* est une carte interactive de votre boîte de notes qui vous aide à découvrir l'endroit où votre pensée pourrait vouloir croître ensuite. #highlight[Elle ne devient vraiment utile que lorsque vous avez beaucoup de notes dans votre boîte de notes], et bien qu'elle tire parti des liens wiki, elle _*n'est pas*_ une vue de la façon dont vos notes se lient ensemble (ce n'est pas une vue typique de graphe de connaissances). La Vue mycélienne lit l'écriture autour d'une note et fait remonter discrètement deux sortes d'occasions :

- Les *liens latents* sont des pages que vous avez déjà, qui sont mentionnées par leur nom ailleurs dans vos notes, mais qui ne sont pas présentement liées. La vue vous les signale pour que vous puissiez les connecter d'un clic.
- Les *concepts émergents* sont un mot ou une expression qui tend à revenir à travers vos notes, mais qui n'a pas encore de page à lui. La vue vous propose de créer cette page pour vous.

La Vue mycélienne vise à vous aider à répondre à la question _« Où vos connaissances veulent-elles croître ? »_

#callout("note")[
Ce n'est pas un navigateur de rétroliens. Si vous voulez suivre les liens que vous avez délibérément créés, voir #wikilink("4 - Liens et rétroliens"). La Vue mycélienne sert à trouver les connexions que vous n'avez _pas_ encore faites.
]

== Ouvrir la vue

La Vue mycélienne s'ouvre dans son propre onglet, construite autour de la note d'où vous partez (la *note d'ancrage*). Il y a trois façons d'y entrer :

+ *Depuis la barre d'outils de l'éditeur*, vous pouvez cliquer sur l'icône de circuit cérébral dans le groupe de droite de l'en-tête de l'éditeur. Son infobulle indique « Vue mycélienne ancrée à partir de cette note ».
+ *Depuis la palette de commandes*, vous pouvez lancer *Ouvrir la Vue mycélienne* (sous la catégorie Outils), ou appuyer sur `Ctrl+Shift+Y` pendant qu'une note est ouverte.
+ *Depuis un lien wiki*, vous pouvez faire un clic droit sur n'importe quel lien wiki dans votre texte et choisir *Ouvrir dans un onglet Vue mycélienne*. Cela ancre la nouvelle vue sur la _cible_ du lien plutôt que sur votre note courante.

L'onglet porte le nom de la note d'ancrage. Vous pouvez en lire davantage sur l'endroit où vivent ces onglets et panneaux dans #wikilink("1 - L'interface InkyCap").

#callout("important")[
L'analyse a besoin de matière pour travailler. Si votre boîte de notes a *moins de 20 notes*, la Vue mycélienne se révélera vide (aucun concept, aucun lien latent). C'est attendu : il n'y a simplement pas encore assez de matière pour repérer des motifs significatifs. Continuez d'écrire, et elle commencera à fleurir, surtout à mesure que vous atteignez des milliers de notes.
]

== Lire le graphe

Le graphe affiche des nœuds (des boîtes) reliés par des chemins (des lignes). La *légende* le long du bas nomme les quatre sortes de nœuds, chacune avec sa propre couleur :

- *Note d'ancrage* est la note autour de laquelle votre vue est construite. Tout le reste est trouvé en relation avec elle.
- *Lien latent* (ambre, pointillé) est une page existante mentionnée dans votre écriture sans lien. Le nœud affiche le nom de la page et un extrait de l'endroit où elle a été mentionnée, avec une étiquette comme « mentionnée dans 3 notes ».
- *Concept émergent* (brun) est un terme récurrent sans page encore. Son nœud est étiqueté « Page potentielle » et montre où le terme ne cesse d'apparaître, avec une étiquette comme « émergé de 4 notes ».
- *Note source* (gris) est une note existante qui a contribué à l'un de ces signaux, affichée pour que vous puissiez voir d'où vient une suggestion.

Les lignes entre les nœuds sont des *chemins*. Elles signifient que deux nœuds partagent une connexion. Les liens wiki ordinaires apparaissent comme de pâles lignes grises ; les connexions latentes et émergentes reçoivent leur propre style ambre et brun. *Survolez n'importe quelle boîte* pour mettre en lumière seulement ses chemins et estomper tout le reste, ce qui facilite le suivi d'un seul fil.

#callout("tip")[
Ne vous souciez pas des couleurs et des épaisseurs au début. La façon la plus simple d'utiliser la vue est de chercher les boîtes ambre et brunes (ce sont les suggestions) et d'ignorer le reste jusqu'à ce que quelque chose attire votre œil.
]

=== Où vit le détail à l'appui

Pour garder la carte lisible, le graphe reste délibérément clairsemé. Le détail supplémentaire (les décomptes, les extraits, les notes qui ont fait remonter un signal) vit dans le *panneau latéral* plutôt que d'encombrer le canevas. Le graphe demeure un survol épuré, et le panneau contient la matière à lire.

== Agir sur ce que vous trouvez

La vue n'est pas seulement à regarder. Chaque suggestion est une action en un clic :

- *Cliquez sur une note source* pour recentrer la vue entière autour d'elle. Une flèche *Précédent* apparaît dans la barre d'outils pour que vous puissiez retracer vos pas.
- *Cliquez sur un lien latent* pour ouvrir un petit sélecteur listant chaque endroit où le terme a été mentionné. En choisir un ouvre cette note à l'endroit exact, prêt pour que vous enveloppiez la mention d'un lien.
- *Cliquez sur un concept émergent* pour créer une page pour lui. Les termes courts deviennent une nouvelle note d'emblée ; les expressions plus longues vous laissent d'abord raccourcir le titre. La nouvelle note arrive préremplie avec un titre et une liste « Émergé de » de liens de retour vers les notes d'où l'idée provient.

#callout("note")[
Un terme ne compte comme concept émergent que s'il apparaît dans *au moins deux* notes. Un mot utilisé une seule fois n'est qu'un mot, pas encore une idée pour la Vue mycélienne.
]

== Se déplacer

La barre d'outils et les contrôles à l'écran vous laissent explorer confortablement :

- *Profondeur* est un menu déroulant (1, 2 ou 3 ; 2 par défaut) qui définit jusqu'où, à partir de l'ancre, la vue cherche de la matière connexe. Des nombres plus élevés jettent un filet plus large.
- *Recalculer* est le bouton à flèche circulaire qui reconstruit la vue à partir du contenu actuel de votre boîte de notes.
- *Déplacer et zoomer* vous laisse faire glisser le canevas, utiliser les touches fléchées ou le pavé à l'écran, défiler pour zoomer, ou appuyer sur les boutons `+` et `−`. *Ajuster à la vue* recentre tout et s'exécute automatiquement à l'ouverture de la vue.
- *Légende comme filtre* vous laisse cliquer sur n'importe quel élément de la légende pour masquer ou afficher ce genre de boîte, afin de vous concentrer, disons, sur les seuls concepts émergents. Cliquer plutôt sur *Note d'ancrage* met en lumière votre ancre. Elle pulse si elle est à l'écran, ou luit vers le bord si elle a défilé hors de vue.
- *Info* est l'icône ⓘ qui ouvre un panneau d'aide « Qu'est-ce que je regarde ? » expliquant les boîtes, les chemins et les contrôles. Appuyez sur Échap ou cliquez ailleurs pour le faire disparaître.

== Le panneau latéral : contexte lié et filtrage de concepts

Lorsqu'une Vue mycélienne est active, le panneau de droite offre deux onglets.

=== Contexte lié

Ce sont les notes que vous avez déjà liées à votre ancre, qui n'ont pas soulevé de nouveau signal (gardées hors du graphe à dessein, mais listées ici pour que vous ne les perdiez pas de vue). Vous pouvez filtrer la liste, la trier *Par connexions* ou *Par nom*, et déployer n'importe quelle rangée pour voir ce vers quoi elle lie. Survoler une note de contexte met en évidence ses connexions dans le graphe, et vice versa.

=== Filtrage de concepts

La détection de concepts fonctionne en ignorant les mots extrêmement courants (une liste de *mots vides*) pour que la vue fasse remonter de vraies idées plutôt que du remplissage. Le panneau Filtrage de concepts rend ce filtrage visible et réversible :

- *Termes exclus* sont des mots qui reviennent comme un concept, mais qui ont été retenus comme mots vides. Chacun est étiqueté « votre liste » ou « intégré ». Vous pouvez *Récupérer* un mot intégré (pour qu'il soit traité comme significatif et aussi reconnu par le correcteur orthographique) ou *Retirer* un mot que vous avez ajouté vous-même.
- *Mots vides* vous laisse ajouter votre propre mot à ignorer à l'aide de la boîte « Mot à ignorer… », ou ouvrir la liste complète pour la modifier directement. Vous pouvez aussi ajouter un mot vide directement depuis le graphe en faisant un clic droit sur un concept émergent.

Après chaque changement, la vue se rafraîchit pour que vous voyiez l'effet tout de suite.

#callout("warning")[
Si vous modifiez les fichiers de mots vides ou de dictionnaire en dehors d'InkyCap, vos changements prennent effet la *prochaine fois que la Vue mycélienne se charge*. Il n'y a pas de surveillance de fichier en direct. Recalculez simplement, ou rouvrez la vue, pour les prendre en compte.
]

#callout("tip", title: "Détails techniques")[
L'analyse est de la linguistique de corpus, pas un simple parcours de liens. Le moteur effectue un parcours en largeur (BFS) du graphe de liens wiki jusqu'à la profondeur choisie, puis élargit le voisinage avec les notes les plus sémantiquement similaires (similarité cosinus sur des vecteurs TF-IDF par document). Le pointage des termes mêle la PMI sur les bigrammes, la moyenne TF-IDF et un ratio de présence, avec des bonus pour les expressions à plusieurs mots. Les noms de pages existantes sont résolus à partir du radical de fichier de chaque note, de sa propriété `title` et de ses alias, c'est ainsi que le moteur distingue un _lien latent_ (la page existe) d'un _concept émergent_ (pas encore de page). L'ajustement par boîte de notes vit dans deux fichiers en texte brut sous `.inkycap/` : `mycelial-stopwords.txt` pour les exclusions et `dictionary.txt` pour les termes récupérés ou forcés à l'inclusion.
]

== Quel est l'avantage de la vue mycélienne ?

La plupart des applications de prise de notes ne vous montrent que les connexions que vous avez faites volontairement. La Vue mycélienne, elle, lit ce que vous avez déjà écrit et signale les fils que vous auriez pu manquer : une idée à demi mémorisée qui ne cesse de refaire surface, deux notes qui tournent autour du même sujet sans jamais se toucher, un concept prêt à devenir une page. C'est l'une des meilleures façons de transformer un tas de notes en une toile grandissante d'idées, aux côtés des #wikilink("5 - Étiquettes") et des #wikilink("4 - Liens et rétroliens").

== Pages connexes

- #wikilink("4 - Liens et rétroliens")
- #wikilink("5 - Étiquettes")
- #wikilink("1 - L'interface InkyCap")
