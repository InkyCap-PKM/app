#import "/.inkycap/notebox.typ": *
#set text(lang: "fr", region: "CA")

#note(
  title: "Extensions",
  description: "Comment étendre InkyCap dès aujourd'hui grâce à l'onglet Extensions expérimental et à des outils externes, en plus des plugins déclaratifs basés sur des fichiers et d'autres surfaces d'extension.",
  tags: ("documentation",),
)

= Extensions

Vous pouvez ajouter des fonctionnalités importantes à l'aide des #wikilink("3 - Scaffolds, Templates et Packages", label: "templates-and-packages", display: "packages du Typst Universe"), mais #highlight(fill: rgb("#ffd6a8"))[*InkyCap n'a _pas_ pour l'instant son propre écosystème de plugins distinctif*].

InkyCap vous permet de brancher vos propres programmes et petits compléments depuis l'extérieur, pour aider à coller à votre flux de travail particulier. Cette page explique ce que vous pouvez étendre dès aujourd'hui et où trouver les contrôles.

#callout("warning")[
  Les extensions sont *expérimentales*. La fonctionnalité fonctionne, mais elle est jeune, et la façon de configurer les choses pourrait changer dans de futures versions. Dans l'application, vous verrez l'avis « Cette fonctionnalité est expérimentale et pourrait ne pas fonctionner parfaitement. » Voyez ce qui est ici comme une base solide, et non comme un système fini et verrouillé.
]

== Où vivent les extensions

L'essentiel de l'action se passe dans l'onglet *Extensions* de la fenêtre des Paramètres. Ouvrez #wikilink("2 - Paramètres") et regardez dans la liste des onglets à gauche. *Extensions* se trouve à l'avant-dernière place, juste au-dessus de *À propos*.

#callout("note")[
  L'onglet Extensions dans les Paramètres couvre un type précis d'extension : brancher des *programmes externes* à InkyCap. Les autres façons d'étendre l'application (décrites plus bas) sont basées sur des fichiers et n'ont pas d'écran de paramètres. Elles s'adressent à des utilisateurs plus techniques, à l'aise avec la modification d'un petit fichier texte.
]

== Brancher des outils externes

La fonctionnalité phare de l'onglet Extensions est un pont vers des *outils externes* (tout programme déjà présent sur votre ordinateur et auquel vous faites confiance). L'idée est relativement simpliste : InkyCap remet une partie de votre texte au programme, le programme fait son travail et affiche un résultat, et InkyCap reprend ce résultat. C'est ainsi que vous pourriez brancher un correcteur grammatical comme #link("https://languagetool.org")[LanguageTool], un linter de style, une aide à la réécriture par IA, un nettoyage de dictée, ou à peu près n'importe quoi d'autre.

#callout("important")[
  InkyCap est livré avec *aucune* extension intégrée et ne lance *rien* de lui-même. Un outil d'extension ne s'exécute jamais que parce que vous l'avez explicitement ajouté et que vous avez pointé InkyCap vers l'emplacement du programme. C'est le même modèle de confiance que les connexions d'InkyCap à Pandoc et à Zotero. C'est vous qui décidez de ce qui s'exécute.
]

=== Ajouter un outil, étape par étape

+ Dans les Paramètres, ouvrez l'onglet *Extensions*.
+ Sélectionnez *Ajouter un outil*. Une nouvelle carte apparaît.
+ Donnez à l'outil un *Nom* (par exemple, « Correction grammaticale »). C'est le nom que vous verrez plus tard quand vous le lancerez.
+ Réglez la *Commande* sur le programme que vous voulez exécuter. Utilisez *Parcourir* pour choisir le fichier du programme, ou collez son emplacement complet.
+ Optionnellement, remplissez les *Arguments*, choisissez ce qui est envoyé à l'outil, et choisissez ce qu'InkyCap fait avec le résultat (voir ci-dessous).
+ Optionnellement, choisissez une *icône* pour l'onglet de sortie de l'outil.

Un outil devient exécutable dès qu'il a à la fois un nom et une commande. Pour retirer un outil, utilisez le bouton *X* sur sa carte.

=== Choisir ce que l'outil reçoit et renvoie

Chaque carte d'outil vous laisse décider exactement comment le texte entre et sort.

- *Envoyer à l'outil* est ce qu'InkyCap fournit au programme :
  - « Texte sélectionné » envoie seulement ce que vous avez mis en surbrillance.
  - « Note entière » envoie la note au complet.
  - « Rien » n'envoie aucun texte (utile quand l'outil prend son entrée autrement ; voir l'aparté ci-dessous).

- *Utiliser le résultat* est ce qu'InkyCap fait avec ce que le programme affiche :
  - « Remplacer la sélection » échange votre texte mis en surbrillance contre le résultat. Utile pour les réécritures et les corrections.
  - « Insérer au curseur » dépose le résultat à l'emplacement de votre curseur, en laissant en place tout texte sélectionné.
  - « Afficher un message temporaire » fait apparaître brièvement un court message contextuel et laisse votre note intacte. Idéal pour les réponses d'une ligne.
  - « L'afficher dans un panneau latéral » ouvre un panneau durable à droite (à côté de Propriétés, Plan et Liens) avec les résultats de l'outil. Idéal pour les rapports plus longs. Le panneau est rattaché à la note sur laquelle vous l'avez lancé, et relancer l'outil rafraîchit le même panneau.

- *Afficher dans* est l'endroit où vous accéderez à l'outil :
  - « Palette de commandes » (le choix par défaut) le place sous une catégorie *Outils* dans la palette de commandes globale. Cela garde votre sélection intacte, ce qui convient aux outils qui agissent sur du texte sélectionné.
  - « Éditeur / menu » le place dans le menu `/` de l'éditeur. Taper `/` remplace votre sélection au fur et à mesure, ce qui convient aux outils qui insèrent du texte.
  - « Les deux ».

- *Envoyer en texte brut seulement* est activé par défaut. Avec ceci activé, InkyCap retire le balisage Typst, les propriétés, le math et le code avant l'envoi, afin que le programme ne reçoive que votre prose. C'est idéal pour les correcteurs grammaticaux et stylistiques. Désactivez-le si votre outil a besoin de la source brute.

#callout("tip")[
  Choisissez « Palette de commandes » + « Remplacer la sélection » pour les aides à la révision (grammaire, réécriture), et « L'afficher dans un panneau latéral » pour les outils qui produisent un rapport que vous voulez continuer à lire. Si un outil ne fait que répondre à une question rapide, « Afficher un message temporaire » garde les choses bien rangées.
]

=== Choses à savoir sur la sécurité et les limites

- *La vie privée reste entre vos mains.* InkyCap n'envoie vos notes nulle part de lui-même. Si un outil que vous avez configuré communique avec un service réseau, c'est votre choix délibéré ; le texte de votre note va là où vous l'avez pointé.
- *La sortie est bornée.* Le résultat d'un outil est plafonné à 8 Mo, et toute exécution qui prend plus de 60 secondes est arrêtée automatiquement, donc un programme qui se comporte mal ne peut pas emporter votre session.
- *Pas de surprises.* InkyCap n'exécute que le programme exact que vous avez enregistré, identifié à l'interne pour que le chemin ne puisse pas être substitué ailleurs, et il ne fait pas passer les commandes par un shell.

#callout("tip", title: "Détails")[
  C'est un simple pont de tube Unix : InkyCap écrit dans le *stdin* du programme et applique son *stdout* ; le *stderr* est jeté et un code de sortie non nul est signalé comme un échec. Les *Arguments* sont un par ligne et passés sous forme de vecteur (jamais une chaîne de shell), avec trois espaces réservés littéraux substitués tels quels :

  ```
  $INKYCAP_NOTEBOX_ROOT   le dossier racine de la boîte de notes ouverte
  $INKYCAP_FILE           le chemin de la note actuelle
  $INKYCAP_SELECTION      le texte sélectionné (toujours brut, même quand
                          « Envoyer en texte brut seulement » est activé)
  ```

  Pour un programme qui lit son entrée depuis les arguments plutôt que depuis un flux, réglez *Envoyer à l'outil* sur « Rien » et mettez `$INKYCAP_SELECTION` (ou `$INKYCAP_FILE`) dans *Arguments*. Le retrait vers du texte brut utilise un extracteur basé sur l'AST qui suit l'analyseur Typst, donc il suit la vraie structure plutôt que de deviner avec des motifs. Les utilisateurs avancés peuvent aussi modifier `external_tools.tools` directement dans `settings.json`.
]

== Autres façons d'étendre InkyCap

L'onglet Extensions est l'une de plusieurs surfaces d'extension. Les autres sont basées sur des fichiers (vous créez ou modifiez un petit fichier plutôt que d'utiliser un écran de paramètres), et aucune d'elles ne nécessite de modifier ou de recompiler InkyCap.

=== Plugins déclaratifs

Un plugin déclaratif est un unique fichier JSON qui ajoute des *données*, pas du code. Il peut contribuer deux choses :

- *Commandes* sont de nouvelles entrées dans le menu `/` de l'éditeur qui insèrent un extrait de balisage à l'emplacement de votre curseur.
- *Vues* sont des boutons sur la barre d'outils de gauche qui ouvrent un panneau latéral listant chaque note qui correspond à une requête de recherche que vous précisez.

Comme un plugin déclaratif n'exécute aucun code, il ne peut pas lire vos notes de lui-même ni joindre le réseau ; il n'y a rien à quoi faire confiance. Vous en ajoutez un en déposant un fichier `.json` dans un dossier de plugins (soit un dossier global pour chaque boîte de notes, soit un dossier à l'intérieur d'une boîte de notes précise pour qu'il voyage avec elle), puis en rouvrant la boîte de notes. Il n'y a pas encore d'écran de paramètres pour cela ; c'est destiné aux utilisateurs aguerris à l'aise avec la modification d'un petit fichier texte.

#callout("example")[
  Un court manifeste avec une commande qui insère un titre et une vue, qui liste vos entrées de journal, ajoute deux commandes `/` et un bouton de barre latérale la prochaine fois que vous ouvrez la boîte de notes, sans recompilation requise.
]

=== Le format ouvert de la boîte de notes et les packages Typst

Deux autres surfaces complètent le tableau :

- *Le format ouvert de la boîte de notes.* Votre boîte de notes est du Typst ordinaire plus un dossier `.inkycap/` documenté, et toutes vos métadonnées sont lisibles avec les outils Typst standards. Cela veut dire que n'importe quel autre programme peut lire et écrire vos notes directement, sans passer par InkyCap du tout.
- *Packages Typst.* Le nouveau comportement au niveau du document (callouts personnalisés, schémas de métadonnées, aides à la mise en page) vient de l'extension du package Typst intégré d'InkyCap ou de l'importation d'un package depuis le #link("https://typst.app/universe/")[Typst package universe]. C'est la maison naturelle de tout ce qui touche à l'allure ou à la compilation de vos documents. Voir #wikilink("3 - Scaffolds, Templates et Packages").

== Ce qui n'est pas encore là

Limites actuelles :

- Il n'y a *pas* de système installable de plugins de code. Il n'y a pas de marché, pas de bac à sable pour exécuter du code de complément arbitraire, et pas d'API de plugins au-delà des surfaces ci-dessus.
- Les plugins déclaratifs n'ont *pas* encore d'interface dans l'application ; vous modifiez le fichier JSON à la main.
- Un environnement d'exécution de plugins plus poussé, intégré à l'application (pensez à des panneaux personnalisés et à du calcul intégré), est une *direction future possible*, et non quelque chose que vous pouvez utiliser aujourd'hui.

Les fondations (des contrats documentés et stables plutôt que des rouages cachés) sont délibérées pour que de futures extensions puissent s'insérer sans briser ce que vous avez bâti. Pour l'instant, le pont vers les outils externes et les plugins déclaratifs vous donnent quelques possibilités, et ils devraient continuer à fonctionner à mesure qu'InkyCap évolue.

== Pages connexes

- #wikilink("2 - Paramètres")
- #wikilink("3 - Scaffolds, Templates et Packages")
- #wikilink("7 - Citations et bibliographie")
- #wikilink("1 - Importation et extensions")
