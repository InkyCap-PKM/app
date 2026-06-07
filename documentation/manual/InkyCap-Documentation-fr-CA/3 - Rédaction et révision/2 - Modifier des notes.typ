#import "/.inkycap/notebox.typ": *
#set text(lang: "fr", region: "CA")

#note(
  title: "Modifier des notes",
  description: "Comment les notes s'ouvrent et comment vous y travaillez : les modes Source, Visuel et Lecture, les formats de lecture, la commande barre oblique et la barre latérale de droite.",
  tags: ("documentation",),
)

= Modifier des notes

== Travailler dans une note

Quand vous ouvrez une note, elle apparaît dans le *volet d'édition* central, surmonté d'une barre d'en-tête. De là, vous pouvez écrire, voir votre travail rendu comme une page finie, insérer n'importe quoi d'un titre à une citation et vous servir de la barre latérale de droite pour naviguer dans votre travail.


== Les trois modes d'édition

Toute note peut être affichée dans l'un de trois modes. Vous passez de l'un à l'autre avec le *sélecteur de mode* (les trois petits boutons à l'extrémité droite de la barre d'en-tête de la note).
#align(center)[#image("/Assets/editor-mode-buttons.png", width: 25%)]
+ *Source* (l'icône `Code`, infobulle *« Source edit »*) affiche la source Typst brute exactement telle qu'elle est enregistrée : numéros de ligne, coloration syntaxique, repliement de code, correspondance des crochets et une marge qui signale les problèmes. C'est la vue la plus directe, du genre « montre-moi tout ».
+ *Visuel* (l'icône `PenLine`, infobulle *« Visual edit »*) est une surface d'écriture conviviale et peu distrayante, utile dans le paradigme de gestion des connaissances d'InkyCap. Votre *gras* s'affiche en gras, vos titres ressemblent à des titres et les bouts de balisage Typst restent cachés jusqu'à ce que vous en ayez besoin. L'approche de l'éditeur visuel s'apparente à ce qu'on appelle souvent un éditeur WYSIWYM (what you see is what you mean, « ce que vous voyez est ce que vous voulez dire »).
+ *Lecture* (l'icône `Eye`, infobulle *« Reading view »*) affiche votre note entièrement rendue et en lecture seule, telle que la page finie apparaîtra vraiment.

Pour changer de mode, cliquez sur le segment voulu. Le choix est *par onglet* : si vous avez divisé votre espace de travail (voir #wikilink("1 - L'interface InkyCap")), vous pouvez ouvrir la même note dans différents modes.

#callout("tip")[ Vous pouvez choisir le mode dans lequel les notes s'ouvrent par défaut. Allez dans #wikilink("2 - Paramètres") → *« Editing mode preference »* et choisissez *Source Mode* ou *Visual Edit*. Les nouvelles notes s'ouvrent en Visual Edit à moins que vous ne changiez ce réglage. ]
#callout("note")[ Une poignée de fichiers en coulisses (les scaffolds et packages propres à InkyCap) s'ouvrent toujours en mode source et masquent le sélecteur de mode. Ce sont des pièces fonctionnelles de votre boîte de notes, pas des notes dans lesquelles vous écrivez ; InkyCap les garde donc telles quelles. ]

=== Mode source : le portrait complet

Le mode source est la vue Typst sans filtre. Si le balisage Typst vous est familier, ou si vous voulez voir précisément ce que contient une note, vous êtes chez vous. Il offre les numéros de ligne, les commandes de repliement, la correspondance des crochets et une marge de vérification qui pointe les erreurs avant qu'elles n'atteignent votre sortie.

=== Mode visuel : une couche pratique, pas un format différent

Le mode visuel décore par-dessus le balisage Typst, pour que l'affichage d'InkyCap ressemble davantage à de la prose finie.

Le mode visuel reconnaît directement la #link("https://typst.app/docs/reference/syntax/")[syntaxe] d'écriture *propre* à Typst. Tapez `*comme ceci*` pour du gras, `_comme ceci_` pour de l'italique, `= ` pour commencer un titre, `- ` pour une puce, `+ ` pour un élément numéroté et `$...$` pour des mathématiques. Ou en utilisant des fonctions comme `#link()`.

#callout("important")[ InkyCap est natif Typst : les habitudes Markdown ne se transposent donc pas. Écrire `**bold**` ou commencer un titre par `#` apparaîtra *littéralement* dans votre sortie. Ce ne sont pas des raccourcis ici. En cas de doute, la commande barre oblique (ci-dessous) insère le bon balisage à votre place. ]

Pour vous éviter de fixer du code, tout ce qui est plus élaboré qu'une simple mise en forme (un callout, une image, une citation avec attribution) se replie dans une petite *pastille `#` cerclée* affichant le nom de la fonctionnalité. La pastille est votre prise sur cet élément :

- *Cliquez* sur une pastille simple pour révéler son balisage Typst sous-jacent là où il se trouve, afin de le modifier. Quand votre curseur s'éloigne, il se range de nouveau en pastille.
- *Faites un clic droit* sur une pastille (ou appuyez sur Entrée ou Espace quand elle a le focus) pour ouvrir son *super-menu*. Vous y trouverez des options propres à l'élément (le texte de remplacement et la largeur d'une image, le type d'un callout, l'attribution d'une citation, la couleur d'un surlignage), des moyens rapides de *modifier la source* ou de basculer toute la note en mode Source ou Visuel, ainsi que des actions universelles comme *Copier*, *Dupliquer*, *Retirer le style* et *Supprimer*.

Quelques éléments s'affichent toujours sous leur forme finie plutôt qu'en pastilles, parce que c'est plus convivial : les liens wiki, les étiquettes, les liens et les tâches se rendent en ligne et restent interactifs (vous pouvez même cocher une case `#task` directement à l'intérieur d'un callout). Le corps des callouts et des citations est du vrai texte modifiable ; vous y tapez comme partout ailleurs.

#callout("tip", title: "Pour les développeurs ou les utilisateurs avancés")[ Le mode visuel est une couche de décoration CodeMirror 6 (« niveau 1 / Live Preview »), jamais un aller-retour d'analyse-et-sérialisation à la ProseMirror. La mémoire tampon reste du Typst en tout temps : aucune conversion de modèle avec perte à craindre. Le système de pastilles, c'est `FuncPillWidget` plus l'unique effet `expandFunc`. Les appels « simples » (une ligne, ≤120 caractères, ≤1 appel `#` imbriqué) se déploient en ligne au clic ; les appels complexes ouvrent le super-menu. Les lignes `#import` de tête sont masquées et verrouillées, et vos règles `#set`/`#show` de tête se regroupent dans une pastille de préambule *Document style*. Les suggestions de complétion de code sont supprimées en mode visuel et conservées en mode Source. Si vous préférez que le balisage se révèle automatiquement quand votre curseur entre dans une pastille, activez #wikilink("2 - Paramètres") → *« Auto-expand markup »* (désactivé par défaut). ]

=== Mode lecture : voir la page finie

Le mode lecture prend un moment pour compiler votre note, puis affiche le résultat rendu, en lecture seule. C'est pratique pour relire des notes sans les modifier par accident, pour corriger des épreuves, partager votre écran ou vérifier la composition avant d'exporter vers d'autres formats. Quand vous passez en mode lecture, InkyCap enregistre d'abord toute modification en attente, de sorte que ce que vous voyez est à jour.

Le mode lecture propose *deux formats de rendu*, choisis avec un second sélecteur (intitulé *« Reading format »*) qui apparaît à côté du sélecteur de mode :

- *SVG* (l'icône `BookA`, *« Render as SVG (paginated) »*) affiche votre note paginée, exactement comme le futur PDF, avec cadres de page, marges et tout le tralala. C'est le meilleur aperçu d'un document imprimé ou exporté.
- *HTML* (l'icône `FileCode`, *« Render as HTML (copyable) »*) affiche une mise en page fluide de style web dont vous pouvez *sélectionner et copier* le texte, et où la vidéo et l'audio intégrés se lisent. Tournez-vous vers ce format quand vous voulez récupérer du texte ou vérifier comment la note se lit en page web.

Le format de lecture est mémorisé par onglet, avec retour à votre valeur par défaut (SVG, à moins que vous ne changiez *« default reading format »* dans #wikilink("2 - Paramètres")).

#callout("note")[ Si une note comporte une erreur qui empêche une partie de se compiler, le mode lecture affiche un diagnostic et, lorsque c'est possible, rend tout de même le reste avec la note : *« Showing a partial render. The errored content below was skipped so the rest of the document stays visible. »* Vous n'êtes jamais laissé devant une page blanche à cause d'une seule erreur isolée. ]

== Insérer des éléments avec la commande barre oblique

En mode visuel, tapez `/` au début d'un mot pour ouvrir la *palette de commandes barre oblique*, un menu rapide pour insérer presque n'importe quoi sans avoir à mémoriser son balisage. Elle est répartie en catégories : *Format, Structure, Insert, Symbol, InkyCap, Style* et *Tools*.

- Déplacez-vous avec les flèches *haut/bas*, *déployez un groupe* avec la flèche droite et *acceptez* avec Entrée ou Tab (un clic fonctionne aussi). Échap la referme.
- Chaque rangée affiche son raccourci de frappe à l'extrémité droite, de sorte que la palette sert aussi d'aide-mémoire.
- Si du texte est sélectionné quand vous déclenchez un élément, votre sélection est enveloppée. Sélectionnez une phrase, choisissez *Bold*, et elle est mise en gras sur place.

De là, vous pouvez insérer des titres, des listes, des liens, des images, de la vidéo et de l'audio (chacun ouvre un sélecteur de fichiers), des tableaux, des notes de bas de page, des citations, des sauts de page, des callouts, des liens wiki, des tâches et des échéances, des règles de style de page et de police, et bien plus.

#callout("tip")[ La palette barre oblique est la façon la plus conviviale de découvrir ce qu'InkyCap peut insérer. Parcourez les catégories même quand vous n'avez besoin de rien de précis ; c'est une visite guidée de l'éditeur. Vous pouvez la désactiver sous #wikilink("2 - Paramètres") → *« Slash / command shortcut »*, mais la plupart des gens la laissent activée. ]

Il existe aussi quelques *raccourcis de frappe* qui se déploient à mesure que vous écrivez en mode Édition visuelle, par exemple :
```typ
[[Nom]]    →  un lien wiki vers « Nom »
> texte    →  une citation en bloc (en début de ligne)
- [ ] tâche →  une tâche cochable
- [x] fait →  une tâche terminée
```

== Autres commodités pendant l'écriture

InkyCap tente de rester à l'écart de votre chemin et de garder votre travail en sécurité :

- *Les touches de mise en forme rapide* sont là quand vous les voulez, par exemple Ctrl/Cmd+B pour le gras, Ctrl/Cmd+I pour l'italique et Ctrl/Cmd+F pour ouvrir le panneau de rechercher-remplacer dans la note. Voir #wikilink("3 - Raccourcis clavier") pour la liste complète.
- *L'auto-appariement* peut fermer pour vous vos crochets, vos guillemets et vos marques de mise en forme, et envelopper une sélection quand vous tapez un `*` ou un `_` autour.
- *L'enregistrement automatique* écrit vos modifications sur le disque tout seul peu après que vous cessez de taper ; pas de bouton Enregistrer à retenir.
- *La correction orthographique*, le *mode focus*, le *défilement machine à écrire* et une *barre d'outils contextuelle sur le texte sélectionné* sont tous offerts ; vous pouvez activer ou désactiver chacun dans #wikilink("2 - Paramètres").

== La barre latérale de droite épaule la note ouverte

Pendant que vous écrivez, la *barre latérale de droite* garde à portée de main des informations utiles sur la note courante. Dans un espace de travail divisé, elle suit le volet sur lequel vous êtes concentré. Ses onglets comprennent :

- *Plan* est un arbre vivant des titres de la note. Cliquez sur n'importe quel titre pour y sauter, et déployez ou repliez l'arbre entier d'un coup.
- *Propriétés* contient les métadonnées typées de la note (ses propriétés système comme le titre, les dates, la collection, ainsi que toute propriété personnalisée que vous créez), plus des actions de fichier comme Renommer, Déplacer, Ajouter aux signets et Exporter. Voir #wikilink("6 - Propriétés des notes").
- *Liens* affiche les *liens sortants* de la note, ses *liens entrants* (rétroliens) et les *liens wiki possibles* que vous pourriez vouloir créer. Voir #wikilink("4 - Liens et rétroliens").
- *Références* rassemble les citations et la bibliographie de la note. Voir #wikilink("7 - Citations et bibliographie").
- *Changes & History* recueille les suggestions, les annotations et tout changement arrivé depuis votre dernière synchronisation, avec une pastille quand quelque chose réclame votre attention (cela sert surtout dans un contexte de collaboration).

== Autres perspectives

La barre d'en-tête vous donne aussi accès à deux autres façons de voir votre travail, chacune s'ouvrant dans son propre espace plutôt que de modifier la note sur place :

- Le bouton *Rouleau de journal* transforme un onglet en un fil continu et chronologique de vos notes, formidable pour les journaux intimes, les carnets de labo et l'écriture quotidienne. Voir #wikilink("4 - Rouleau de journal").
- Le bouton *Vue mycélienne* (l'icône `BrainCircuit`) ouvre un nouvel onglet proposant comment faire croître vos notes à travers les idées qu'elles partagent, en s'ancrant sur la note que vous lisez. Voir #wikilink("5 - Vue mycélienne").

== Pages connexes

- #wikilink("3 - Mettre en forme votre texte")
- #wikilink("4 - Liens et rétroliens")
- #wikilink("6 - Propriétés des notes")
- #wikilink("7 - Citations et bibliographie")
- #wikilink("1 - Vues et navigation")
- #wikilink("3 - Raccourcis clavier")
- #wikilink("2 - Paramètres")
