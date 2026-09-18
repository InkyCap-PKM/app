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
#align(center)[#image("/Assets/editor-mode-buttons.png", width: 16%, alt: "Les trois boutons de mode de l'éditeur : Source, Visuel et Lecture")]
+ *Source* (l'icône `Code`, infobulle *« Édition source »*) affiche la source Typst brute exactement telle qu'elle est enregistrée : numéros de ligne, coloration syntaxique, repliement de code, correspondance des crochets et une marge qui signale les problèmes. C'est la vue la plus directe, du genre « montre-moi tout ».
+ *Visuel* (l'icône `PenLine`, infobulle *« Édition visuelle »*) est une surface d'écriture conviviale et peu distrayante, utile dans le paradigme de gestion des connaissances d'InkyCap. Votre *gras* s'affiche en gras, vos titres ressemblent à des titres et les bouts de balisage Typst restent cachés jusqu'à ce que vous en ayez besoin. L'approche de l'éditeur visuel s'apparente à ce qu'on appelle souvent un éditeur WYSIWYM (what you see is what you mean, « ce que vous voyez est ce que vous voulez dire »).
+ *Lecture* (l'icône `Eye`, infobulle *« Mode lecture »*) affiche votre note entièrement rendue et en lecture seule, telle que la page finie apparaîtra vraiment.

Pour changer de mode, cliquez sur le segment voulu. Le choix est *par onglet* : si vous avez divisé votre espace de travail (voir #wikilink("1 - L'interface InkyCap")), vous pouvez ouvrir la même note dans différents modes.

#callout("tip")[ Vous pouvez choisir le mode dans lequel les notes s'ouvrent par défaut. Allez dans #wikilink("2 - Paramètres") → *« Préférence de mode d'édition »* et choisissez *Mode source* ou *Édition visuelle*. Les nouvelles notes s'ouvrent en Édition visuelle à moins que vous ne changiez ce réglage. ]
#callout("note")[ Une poignée de fichiers en coulisses (les scaffolds et packages propres à InkyCap) s'ouvrent toujours en mode source et masquent le sélecteur de mode. Ce sont des pièces fonctionnelles de votre boîte de notes, pas des notes dans lesquelles vous écrivez ; InkyCap les garde donc telles quelles. ]

=== Mode source : le portrait complet

Le mode source est la vue Typst sans filtre. Si le balisage Typst vous est familier, ou si vous voulez voir précisément ce que contient une note, vous êtes chez vous. Il offre les numéros de ligne, les commandes de repliement, la correspondance des crochets et une marge de vérification qui pointe les erreurs avant qu'elles n'atteignent votre sortie.

=== Mode visuel : une couche pratique, pas un format différent

Le mode visuel décore par-dessus le balisage Typst, pour que l'affichage d'InkyCap ressemble davantage à de la prose finie.

Le mode visuel reconnaît directement la #link("https://typst.app/docs/reference/syntax/")[syntaxe] d'écriture *propre* à Typst. Tapez `*comme ceci*` pour du gras, `_comme ceci_` pour de l'italique, `= ` pour commencer un titre, `- ` pour une puce, `+ ` pour un élément numéroté et `$...$` pour des mathématiques. Ou en utilisant des fonctions comme `#link()`.

#callout("important")[ Rappelez-vous qu'InkyCap est natif Typst. Il peut importer et exporter du Markdown, mais il ne fonctionne pas comme un éditeur Markdown ; les habitudes Markdown ne se transposent donc pas. Écrire `**bold**` ou commencer un titre par `#` apparaîtra *incorrectement* dans votre sortie. En cas de doute, la commande barre oblique (ci-dessous) insère le bon balisage à votre place. ]

Pour vous éviter de fixer du code, tout ce qui est plus élaboré qu'une simple mise en forme (un callout, une image, une citation avec attribution) se replie dans une petite *pastille `#` cerclée* affichant le nom de la fonctionnalité. La pastille est votre prise sur cet élément :

- *Cliquez* sur une pastille simple pour révéler son balisage Typst sous-jacent là où il se trouve, afin de le modifier. Quand votre curseur s'éloigne, il se range de nouveau en pastille.
- *Faites un clic droit* sur une pastille (ou appuyez sur Entrée ou Espace quand elle a le focus) pour ouvrir son *super-menu*. Vous y trouverez des options propres à l'élément (le texte alternatif et la largeur d'une image, le type d'un callout, l'attribution d'une citation, la couleur d'un surlignage), des moyens rapides de *Modifier la source* ou de basculer toute la note en mode Source ou Visuel, ainsi que des actions universelles comme *Copier*, *Dupliquer*, *Retirer le style* et *Supprimer*.

Quelques éléments s'affichent toujours sous leur forme finie plutôt qu'en pastilles, parce que c'est plus convivial : les liens wiki, les étiquettes, les liens et les tâches se rendent en ligne et restent interactifs (vous pouvez même cocher une case `#task` directement à l'intérieur d'un callout). Le corps des callouts et des citations est du vrai texte modifiable ; vous y tapez comme partout ailleurs.

#callout("tip", title: "Pour les développeurs ou les utilisateurs avancés")[ Le mode visuel est une couche de décoration CodeMirror 6 (« niveau 1 / Live Preview »). Les commentaires Typst (`//` et `/* */`) sont masqués et verrouillés en mode visuel ; basculez en mode source pour les lire ou les modifier. Les suggestions de complétion de code sont supprimées en mode visuel et conservées en mode Source. Si vous préférez que le balisage se révèle automatiquement quand votre curseur entre dans une pastille, activez #wikilink("2 - Paramètres") → *« Développement automatique du balisage »* (désactivé par défaut). ]

=== Mode lecture : voir la page finie

Le mode lecture prend un moment pour compiler votre note, puis affiche le résultat rendu, en lecture seule. C'est pratique pour relire des notes sans les modifier par accident, pour corriger des épreuves, partager votre écran ou vérifier la composition avant d'exporter vers d'autres formats. Quand vous passez en mode lecture, InkyCap enregistre d'abord toute modification en attente, de sorte que ce que vous voyez est à jour.

Le mode lecture propose *deux formats de rendu*, choisis avec un second sélecteur (intitulé *« Format de lecture »*) qui apparaît à côté du sélecteur de mode :

- *SVG* (l'icône `BookA`, *« Afficher en SVG (paginé) »*) affiche votre note paginée, exactement comme le futur PDF, avec cadres de page, marges et tout le tralala. C'est le meilleur aperçu d'un document imprimé ou exporté.
- *HTML* (l'icône `FileCode`, *« Afficher en HTML (copiable) »*) affiche une mise en page fluide de style web dont vous pouvez *sélectionner et copier* le texte, et où la vidéo et l'audio intégrés se lisent. Tournez-vous vers ce format quand vous voulez récupérer du texte ou vérifier comment la note se lit en page web.

Le format de lecture est mémorisé par onglet, avec retour à votre valeur par défaut (SVG, à moins que vous ne changiez *« Préférence de format du mode lecture »* sous *Apparence* dans #wikilink("2 - Paramètres")).

#callout("note")[ Si une note comporte une erreur qui empêche une partie de se compiler, le mode lecture affiche un diagnostic et, lorsque c'est possible, rend tout de même le reste avec la note : *« Affichage d'un rendu partiel — le contenu en erreur ci-dessous a été ignoré afin que le reste du document demeure visible. »* Vous n'êtes jamais laissé devant une page blanche à cause d'une seule erreur isolée. ]

== Insérer des éléments avec la commande barre oblique

En mode visuel, tapez `/` au début d'un mot pour ouvrir la *palette de commandes barre oblique*, un menu rapide pour insérer presque n'importe quoi sans avoir à mémoriser son balisage. Elle est répartie en catégories : *Format, Structure, Insérer, Symbole, InkyCap, Style* et *Outils*.

- Déplacez-vous avec les flèches *haut/bas* (*PageUp* et *PageDown* sautent plusieurs rangées à la fois), *déployez un groupe* avec la flèche droite et *acceptez* avec Entrée ou Tab (un clic fonctionne aussi). Échap la referme.
- Chaque rangée affiche son raccourci de frappe à l'extrémité droite, de sorte que la palette sert aussi d'aide-mémoire.
- Si du texte est sélectionné quand vous déclenchez un élément, votre sélection est enveloppée. Sélectionnez une phrase, choisissez *Gras*, et son apparence change en conséquence.

De là, vous pouvez insérer des titres, des listes, des liens, des images, de la vidéo et de l'audio (chacun ouvre un sélecteur de fichiers), des tableaux, des notes de bas de page, des citations, des sauts de page, des callouts, des liens wiki, des tâches et des échéances, des règles de style de page et de police, et bien plus.

#callout("tip")[ La palette barre oblique est la façon la plus conviviale de découvrir ce qu'InkyCap peut insérer. Parcourez les catégories pour une visite guidée de l'éditeur. Vous pouvez la désactiver sous #wikilink("2 - Paramètres") → *« Raccourci de commande barre oblique / »*, mais la plupart des gens la laissent activée. ]

Il existe aussi quelques *raccourcis de frappe* qui se déploient à mesure que vous écrivez en mode Édition visuelle, par exemple :
```typ
[[Nom]]    →  un lien wiki vers « Nom »
> texte    →  une citation en bloc (en début de ligne)
- [ ] tâche →  une tâche cochable
- [x] fait →  une tâche terminée
```

Les raccourcis de tâche conservent le marqueur de liste : `- [ ]` devient donc un élément de liste contenant une tâche (`- #task("")`), que vous pouvez imbriquer ou déplacer comme n'importe quel autre élément.

== Autres commodités pendant l'écriture

- *Les touches de mise en forme rapide* sont là quand vous les voulez, par exemple Ctrl/Cmd+B pour le gras, Ctrl/Cmd+I pour l'italique et Ctrl/Cmd+F pour ouvrir le panneau de rechercher-remplacer dans la note. Voir #wikilink("3 - Raccourcis clavier") pour la liste complète.
- *L'appariement automatique* se présente sous la forme de deux réglages sous *Éditeur* dans #wikilink("2 - Paramètres"). *Appariement automatique des parenthèses* ferme pour vous les crochets et les guillemets. *Appariement automatique du balisage Typst* enveloppe le texte sélectionné quand vous tapez `*`, `_`, un accent grave ou `$` autour, et ferme un accent grave en paire.
- *L'enregistrement automatique* écrit vos modifications sur le disque tout seul peu après que vous cessez de taper ; pas de bouton Enregistrer à retenir.
- *La correction orthographique* souligne les mots mal orthographiés à mesure que vous tapez, à l'aide de dictionnaires Hunspell intégrés. Sous *Langue* dans #wikilink("2 - Paramètres"), vous pouvez activer plusieurs dictionnaires à la fois (pratique pour les notes bilingues), et la commande *Langue du correcteur orthographique* de la barre d'état passe de l'un à l'autre. Faites un clic droit sur un mot souligné pour obtenir des suggestions ou pour l'ajouter au *Dictionnaire personnel* de la boîte de notes, qui voyage avec elle.
- *La touche Entrée insère un saut de ligne* (sous *Éditeur*) fait qu'une seule pression sur Entrée commence une nouvelle ligne dans le rendu, en ajoutant un `\` caché à la fin de la ligne ; deux pressions commencent toujours un nouveau paragraphe. Laissez ce réglage désactivé et une seule pression sur Entrée se comporte comme Typst le fait normalement : la ligne suivante rejoint le même paragraphe.
- *Indentation de liste intuitive* (sous *Éditeur*) fait que Tab et Maj+Tab déplacent les éléments imbriqués d'un élément de liste avec lui.
- *Le repliement* range une section, ou les sous-éléments d'un élément de liste, hors de vue. Survolez juste à gauche d'un titre, ou d'un élément de liste qui contient des éléments imbriqués, et un petit chevron apparaît ; cliquez dessus pour replier, et de nouveau pour rouvrir. Le repliement fonctionne en mode Source comme en mode Visuel et reste en place quand vous passez de l'un à l'autre.
- *Mode focus* (sous *Éditeur*) peut être *Désactivé*, *Ligne* ou *Section*, et *Atténuer le texte hors focus* est un interrupteur distinct qui estompe tout ce qui se trouve hors de la partie où vous travaillez ; il fonctionne seul, en gardant votre paragraphe courant net même quand le Mode focus est désactivé. *Mode machine à écrire* et *Barre d'outils contextuelle sur le texte sélectionné* se trouvent au même endroit.

== La barre latérale de droite épaule la note ouverte

Pendant que vous écrivez, la *barre latérale de droite* garde à portée de main des informations utiles sur la note courante. Dans un espace de travail divisé, elle suit le volet sur lequel vous êtes concentré. Ses onglets comprennent :

- *Plan* est un arbre vivant des titres de la note. Cliquez sur n'importe quel titre pour y sauter, et déployez ou repliez l'arbre entier d'un coup.
- *Propriétés* contient les métadonnées typées de la note (ses propriétés système comme le titre, les dates, la collection, ainsi que toute propriété personnalisée que vous créez), plus des actions de fichier comme Renommer, Déplacer, Ajouter un signet et Exporter. Voir #wikilink("6 - Propriétés des notes").
- *Liens* affiche les *Liens sortants* de la note, ses *Liens entrants* (rétroliens) et les *Liens wiki possibles* que vous pourriez vouloir créer. Voir #wikilink("4 - Liens et rétroliens").
- *Références* rassemble les citations et la bibliographie de la note. Voir #wikilink("7 - Citations et bibliographie").
- *Modifications et historique* recueille les suggestions, les annotations et tout changement arrivé depuis votre dernière synchronisation, avec un indicateur quand quelque chose réclame votre attention (cela sert surtout dans un contexte de collaboration).

== Autres perspectives

La barre d'en-tête vous donne aussi accès à deux autres façons de voir votre travail, chacune s'ouvrant dans son propre espace :

- Le bouton *Rouleau de journal* transforme un onglet en un fil continu et chronologique de vos notes, utile pour les journaux intimes, les carnets de labo, l'écriture quotidienne ou pour revoir les notes prises autour d'un moment précis. Voir #wikilink("4 - Rouleau de journal").
- Le bouton *Vue mycélienne* (l'icône `BrainCircuit`) ouvre un nouvel onglet proposant comment faire croître vos notes à travers les idées qu'elles partagent, en s'ancrant sur la note que vous lisez. Voir #wikilink("5 - Vue mycélienne").

== Pages connexes

- #wikilink("3 - Mettre en forme votre texte")
- #wikilink("4 - Liens et rétroliens")
- #wikilink("6 - Propriétés des notes")
- #wikilink("7 - Citations et bibliographie")
- #wikilink("1 - Vues et navigation")
- #wikilink("3 - Raccourcis clavier")
- #wikilink("2 - Paramètres")
