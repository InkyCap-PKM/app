#import "/.inkycap/notebox.typ": *
#set text(lang: "fr", region: "CA")

#note(
  title: "Recherche et récupération",
  description: "Comment chercher dans toute la boîte de notes et à l'intérieur d'une seule note, les opérateurs et les filtres de recherche, l'enregistrement de recherches comme signets, l'Ouverture rapide, le rechercher-remplacer et les signets.",
  tags: ("documentation",),
)

= Recherche et récupération

InkyCap vous offre plusieurs façons de revenir à ce dont vous avez besoin : un panneau *Recherche* qui couvre toute la boîte de notes, un rechercher-remplacer rapide _à l'intérieur_ de la note en cours d'édition, une frappe pour sauter directement à n'importe quel fichier, et des *signets* pour les endroits où vous revenez souvent.

Cette page présente chacun d'eux, les opérateurs de recherche que vous pouvez utiliser et comment effectuer un remplacement sur plusieurs fichiers sans vous causer d'ennuis.

== Chercher dans toute la boîte de notes

Ouvrez le panneau *Recherche* depuis la barre latérale gauche, ou appuyez sur `Ctrl+Shift+F` (la commande « Rechercher dans la boîte de notes »). Tapez dans la case du haut et les résultats apparaissent dès que vous faites une pause; appuyez sur `Entrée` pour chercher immédiatement sans attendre.

#callout("note")[
*InkyCap recherche des mots entiers par défaut.* Taper `ink` trouve le mot _ink_, mais ne correspond *pas* à _inkycap_ ni à _inking_. Cela garde les résultats précis. Pour correspondre à des mots partiels, utilisez l'opérateur de troncature décrit ci-dessous.
]

=== Mots entiers contre troncature `*`

Comme la correspondance par mot entier est l'option par défaut, vous utilisez l'astérisque `*` lorsque vous voulez qu'une racine corresponde à des mots plus longs :

- `ink*` correspond à _ink_, _inkycap_, _inking_ et à tout ce qui commence par « ink ».
- `*ographie` correspond à _bibliographie_, _typographie_, et ainsi de suite.
- `che*ille` ancre aux deux extrémités, correspondant à _chenille_, _cheville_, et autres.

Voyez `*` comme « n'importe quelle suite de caractères ici ». Sans lui, vous obtenez le mot exact et rien de plus.

=== Opérateurs

Vous pouvez combiner les termes au moyen d'un petit langage de requête. Le panneau Recherche propose une fiche *Conseils de recherche* (le bouton point d'interrogation/conseils) qui les énumère sur place, mais les voici au complet :

#table(
  columns: 2,
  stroke: 0.5pt + luma(200),
  inset: 7pt,
  [*Opérateur*], [*Ce qu'il fait*],
  [`"expression exacte"`], [Trouvez une expression exacte de plusieurs mots en l'entourant de guillemets droits doubles.],
  [`AND`], [Les deux termes doivent apparaître. Deux mots sans opérateur entre eux sont déjà traités comme un `AND`, donc `loi fiscale` signifie `loi AND fiscale`.],
  [`OR`], [L'un ou l'autre des termes peut apparaître : `chat OR chien`.],
  [`NOT`], [Exclure un terme : `chat NOT chien`.],
  [`-terme`], [Le signe moins est un raccourci de `NOT` : `chat -chien`.],
  [`( )`], [Regroupe des sous-expressions, y compris des groupes imbriqués : `(chat OR chien) AND véto`.],
  [`a W/5 b`], [Proximité, *ordonnée* : _a_ apparaît à moins de 5 mots *avant* _b_.],
  [`a N/5 b`], [Proximité, *tout ordre* : _a_ et _b_ apparaissent à moins de 5 mots l'un de l'autre.],
)

#callout("tip")[
Les opérateurs booléens (`AND`, `OR`, `NOT`) doivent être écrits en *majuscules* pour qu'InkyCap puisse les distinguer des mots ordinaires que vous recherchez.
]

=== Filtres

Préfixez un terme par l'un de ces filtres pour restreindre la recherche à un type de correspondance précis plutôt qu'au corps de la note :

#table(
  columns: 2,
  stroke: 0.5pt + luma(200),
  inset: 7pt,
  [*Filtre*], [*Ce à quoi il correspond*],
  [`tag:recherche`], [Les notes portant une #wikilink("5 - Étiquettes", display: "étiquette") donnée.],
  [`property:statut=brouillon`], [Les notes dont la #wikilink("6 - Propriétés des notes", display: "propriété") a une valeur. `property:statut` seul correspond à toute note qui possède cette propriété.],
  [`section:méthodes`], [Les notes qui contiennent un titre correspondant au mot-clé.],
  [`file:2026`], [Correspondance par nom de fichier.],
  [`path:journal`], [Correspondance par le chemin du fichier dans la boîte de notes.],
  [`annotation:fixme`], [Correspondance au texte à l'intérieur d'une `#annotation[…]` ou d'une `#suggestion[…]`. `annotation:` seul trouve toute note qui comporte des annotations.],
  [`collection:Lectures`], [Limite les résultats aux notes appartenant à une #wikilink("2 - Collections", display: "collection") précise.],
)

Les filtres se combinent librement avec les opérateurs ci-dessus, donc `tag:recherche méthodes -brouillon` est une requête tout à fait valable.

=== Options de recherche

Trois bascules à côté de la case de recherche changent le mode de correspondance :

- *Sensible à la casse* fait respecter à la recherche les majuscules et minuscules exactes que vous avez tapées. Désactivé par défaut.
- *Utiliser une expression régulière* traite toute la requête comme une expression régulière, pour les cas où les opérateurs ci-dessus ne suffisent pas. La syntaxe d'expression, de booléens et de filtres ne s'applique pas dans ce mode — c'est de l'expression régulière brute.
- *Portée des annotations* est un sélecteur à trois positions : *Tout le texte* (l'option par défaut), *Annotations seulement* (chercher uniquement à l'intérieur des annotations et des suggestions. Une requête vide dans ce mode liste _toutes_ les annotations de la boîte de notes), ou *Exclure les annotations* (chercher seulement la prose et ignorer le texte des annotations).

=== Lire et organiser les résultats

Les résultats sont regroupés par fichier, avec un décompte de correspondances à côté de chaque nom de fichier. Cliquez sur une ligne pour ouvrir cette note à la correspondance; quand une note s'ouvre ainsi, *toutes* ses correspondances sont surlignées pour que vous puissiez les parcourir.

- *Développer / Réduire les résultats* affiche ou masque les lignes correspondantes sous chaque fichier. Vous pouvez aussi inverser ce réglage un fichier à la fois grâce au chevron sur sa rangée.
- *Afficher plus de contexte* élargit chaque résultat pour inclure quelques lignes au-dessus et en dessous de la correspondance, afin que vous puissiez lire le texte environnant sans quitter le panneau. (La ligne `#import` du début de la note est toujours masquée des résultats.)
- *Ordre de tri* propose Pertinence (l'option par défaut), Nom de fichier A–Z ou Z–A, et Date de modification ou de création, du plus récent au plus ancien ou l'inverse. Un fichier dont le nom correspond exactement à votre requête saute en tête.
- Les longs ensembles de résultats sont *paginés* par pages de 500, avec des boutons Précédent / Suivant et un compteur `{from}–{to} sur {total} résultats`.

== Enregistrer une recherche comme signet

Une requête que vous lancez souvent peut être enregistrée pour ne jamais avoir à la retaper. Lancez la recherche, ouvrez le menu *Plus d'actions* au bas du panneau Recherche et choisissez *Mettre l'expression de recherche en signet…*. La requête est stockée dans votre #wikilink("1 - L'interface InkyCap", display: "panneau Signets"); cliquer dessus plus tard rouvre le panneau Recherche avec la requête déjà remplie et relancée. (Voir #wikilink("1 - L'interface InkyCap") pour le fonctionnement des signets en général.)

== Ouverture rapide : sauter directement à un fichier

Quand vous savez déjà à peu près _quelle_ note vous voulez, vous n'avez pas besoin d'une recherche complète. Appuyez sur `Ctrl+O` pour l'*Ouverture rapide*, un sélecteur de fichiers rapide. Commencez à taper une partie du nom d'un fichier et InkyCap le trouve par correspondance floue, classant les meilleures correspondances en premier et départageant les égalités par la note modifiée le plus récemment. Une case vide liste vos fichiers du plus récent au plus ancien. Servez-vous des flèches (ou `Page préc.` / `Page suiv.`, `Début` / `Fin`) pour déplacer la sélection et d'`Entrée` pour l'ouvrir. Si un fichier se trouve dans un dossier, le dossier est affiché à côté de son nom.

Voyez l'Ouverture rapide comme « aller au fichier » et le panneau Recherche comme « trouver ce texte ».

== Rechercher et remplacer dans la note en cours

À l'intérieur de la note que vous éditez, appuyez sur `Ctrl+F` pour ouvrir la barre de recherche au bas de l'éditeur. Utilisez *Suivant* et *Précédent* (ou `Entrée` / `Maj+Entrée`) pour passer d'une correspondance à l'autre, ou activez *Tout* pour surligner toutes les correspondances à la fois. Les mêmes options connues de la recherche sont là : *Respecter la casse*, *Expression régulière* et *Par mot* (correspondance par mot entier). `Échap` ferme la barre.

Pour remplacer dans la note, appuyez sur `Ctrl+H` (« Rechercher et remplacer (dans la note) »), ou révélez la rangée de remplacement grâce au chevron de divulgation de la barre de recherche. Tapez un remplacement et utilisez *Remplacer* pour la correspondance courante ou *Tout remplacer* pour toute la note. La rangée de remplacement reste repliée jusqu'à ce que vous la demandiez, ce qui évite de déclencher un remplacement par accident.

== Remplacer dans toute la boîte de notes

InkyCap peut aussi remplacer du texte dans *tous* les fichiers d'un coup. Cette commande n'a aucun raccourci clavier. Vous l'atteignez par la *palette de commandes* (`Ctrl+P`) en lançant *Rechercher et remplacer (toute la boîte de notes)*. Elle ouvre le panneau Recherche avec un champ de remplacement; saisissez une requête et un remplacement, puis utilisez *Tout remplacer* pour l'appliquer à toute la boîte de notes, ou *Remplacer dans ce fichier* sur un seul groupe de fichier pour en limiter la portée. Elle respecte les bascules *Sensible à la casse* et *Utiliser une expression régulière* (les remplacements par expression régulière peuvent utiliser des groupes de capture comme `$1`).

#callout("warning", title: "Le remplacement sur toute la boîte de notes n'est pas annulable d'un seul coup")[
Un remplacement sur toute la boîte de notes modifie plusieurs fichiers en même temps et il n'existe pas d'unique « annuler » qui les renverse tous. Avant d'en lancer un :

- *Prévisualisez d'abord.* Lancez la même requête comme une recherche ordinaire et lisez les résultats, pour savoir exactement ce qui va changer et où.
- *Soyez précis.* Un terme court ou courant correspondra à bien plus que ce que vous attendez. Appuyez-vous sur la correspondance par mot entier, sur les expressions ou sur les filtres pour resserrer la requête.
- *Gardez un filet de sécurité.* Si votre boîte de notes est sous #wikilink("1 - Collaboration", display: "synchronisation git") ou si vous conservez des sauvegardes, assurez-vous de pouvoir revenir en arrière. Utilisez la palette de commandes (`Ctrl+P`) et sélectionnez l'option « Sauvegarder la boîte de notes maintenant ». L'absence de raccourci pour cette commande est elle-même un garde-fou — traitez-la avec le même soin.
]

== Autres façons de retrouver vos notes

La Recherche et l'Ouverture rapide sont les outils directs, mais plusieurs autres fonctions d'InkyCap relèvent en réalité aussi de la récupération :

- *Filtres de collection.* Une #wikilink("2 - Collections", display: "collection") rassemble les notes qui correspondent à un filtre enregistré (par exemple `statut == "brouillon"` ou `tags.contains("recherche")`). C'est une requête permanente et réutilisable que vous construisez une fois et que vous revisitez, plutôt qu'une recherche ponctuelle — et vous pouvez intégrer une collection à une recherche avec le filtre `collection:` ci-dessus.
- *Liens et rétroliens.* Suivre les #wikilink("4 - Liens et rétroliens", display: "hyperliens wiki et rétroliens") est une navigation par connexion délibérée.
- *Étiquettes.* Le navigateur d'#wikilink("5 - Étiquettes", display: "étiquettes") regroupe les notes selon les libellés que vous leur avez donnés.
- *Vue mycélienne.* La #wikilink("5 - Vue mycélienne") fait remonter les connexions que vous n'avez _pas encore_ faites, plutôt que celles que vous cherchez.

#callout("note")[
Une recherche enregistrée est l'un des trois types de *signets* que conserve InkyCap (avec les notes et les collections). Pour le fonctionnement des signets et toutes les façons de les créer, voyez #wikilink("1 - L'interface InkyCap").
]

== Pages connexes

- #wikilink("1 - L'interface InkyCap")
- #wikilink("2 - Collections")
- #wikilink("4 - Liens et rétroliens")
- #wikilink("5 - Étiquettes")
- #wikilink("5 - Vue mycélienne")
- #wikilink("3 - Raccourcis clavier")
